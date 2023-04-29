import { mapSeries } from 'bluebird'
import { FSWatcher, watch } from 'chokidar'
import { EventEmitter } from 'events'
import { appendFile, ensureDir, readFile, stat } from 'fs-extra'
import { Parser as M3u8Parser } from 'm3u8-parser'
import PQueue from 'p-queue'
import { basename, join } from 'path'
import { computeOutputFPS } from '@server/helpers/ffmpeg'
import { logger, loggerTagsFactory, LoggerTagsFn } from '@server/helpers/logger'
import { CONFIG } from '@server/initializers/config'
import { MEMOIZE_TTL, P2P_MEDIA_LOADER_PEER_VERSION, VIDEO_LIVE } from '@server/initializers/constants'
import { removeHLSFileObjectStorageByPath, storeHLSFileFromContent, storeHLSFileFromPath } from '@server/lib/object-storage'
import { VideoFileModel } from '@server/models/video/video-file'
import { VideoStreamingPlaylistModel } from '@server/models/video/video-streaming-playlist'
import { MStreamingPlaylistVideo, MUserId, MVideoLiveVideo } from '@server/types/models'
import { VideoStorage, VideoStreamingPlaylistType } from '@shared/models'
import {
  generateHLSMasterPlaylistFilename,
  generateHlsSha256SegmentsFilename,
  getLiveDirectory,
  getLiveReplayBaseDirectory
} from '../../paths'
import { isAbleToUploadVideo } from '../../user'
import { LiveQuotaStore } from '../live-quota-store'
import { LiveSegmentShaStore } from '../live-segment-sha-store'
import { buildConcatenatedName, getLiveSegmentTime } from '../live-utils'
import { AbstractTranscodingWrapper, FFmpegTranscodingWrapper, RemoteTranscodingWrapper } from './transcoding-wrapper'

import memoizee = require('memoizee')
interface MuxingSessionEvents {
  'live-ready': (options: { videoUUID: string }) => void

  'bad-socket-health': (options: { videoUUID: string }) => void
  'duration-exceeded': (options: { videoUUID: string }) => void
  'quota-exceeded': (options: { videoUUID: string }) => void

  'transcoding-end': (options: { videoUUID: string }) => void
  'transcoding-error': (options: { videoUUID: string }) => void

  'after-cleanup': (options: { videoUUID: string }) => void
}

declare interface MuxingSession {
  on<U extends keyof MuxingSessionEvents>(
    event: U, listener: MuxingSessionEvents[U]
  ): this

  emit<U extends keyof MuxingSessionEvents>(
    event: U, ...args: Parameters<MuxingSessionEvents[U]>
  ): boolean
}

class MuxingSession extends EventEmitter {

  private transcodingWrapper: AbstractTranscodingWrapper

  private readonly context: any
  private readonly user: MUserId
  private readonly sessionId: string
  private readonly videoLive: MVideoLiveVideo

  private readonly inputLocalUrl: string
  private readonly inputPublicUrl: string

  private readonly fps: number
  private readonly allResolutions: number[]

  private readonly bitrate: number
  private readonly ratio: number

  private readonly hasAudio: boolean

  private readonly videoUUID: string
  private readonly saveReplay: boolean

  private readonly outDirectory: string
  private readonly replayDirectory: string

  private readonly lTags: LoggerTagsFn

  // Path -> Queue
  private readonly objectStorageSendQueues = new Map<string, PQueue>()

  private segmentsToProcessPerPlaylist: { [playlistId: string]: string[] } = {}

  private streamingPlaylist: MStreamingPlaylistVideo
  private liveSegmentShaStore: LiveSegmentShaStore
  private liveSegmentsInStorage: string[]

  private filesWatcher: FSWatcher
  private m3u8Watcher: FSWatcher
  private m3u8Parser: M3u8Parser

  private masterPlaylistCreated = false
  private liveReady = false

  private aborted = false

  private readonly isAbleToUploadVideoWithCache = memoizee((userId: number) => {
    return isAbleToUploadVideo(userId, 1000)
  }, { maxAge: MEMOIZE_TTL.LIVE_ABLE_TO_UPLOAD })

  private readonly hasClientSocketInBadHealthWithCache = memoizee((sessionId: string) => {
    return this.hasClientSocketInBadHealth(sessionId)
  }, { maxAge: MEMOIZE_TTL.LIVE_CHECK_SOCKET_HEALTH })

  constructor (options: {
    context: any
    user: MUserId
    sessionId: string
    videoLive: MVideoLiveVideo

    inputLocalUrl: string
    inputPublicUrl: string

    fps: number
    bitrate: number
    ratio: number
    allResolutions: number[]
    hasAudio: boolean
  }) {
    super()

    this.context = options.context
    this.user = options.user
    this.sessionId = options.sessionId
    this.videoLive = options.videoLive

    this.inputLocalUrl = options.inputLocalUrl
    this.inputPublicUrl = options.inputPublicUrl

    this.fps = options.fps

    this.bitrate = options.bitrate
    this.ratio = options.ratio

    this.hasAudio = options.hasAudio

    this.allResolutions = options.allResolutions

    this.videoUUID = this.videoLive.Video.uuid

    this.saveReplay = this.videoLive.saveReplay

    this.outDirectory = getLiveDirectory(this.videoLive.Video)
    this.replayDirectory = join(getLiveReplayBaseDirectory(this.videoLive.Video), new Date().toISOString())

    this.lTags = loggerTagsFactory('live', this.sessionId, this.videoUUID)
  }

  async runMuxing () {
    this.streamingPlaylist = await this.createLivePlaylist()

    this.createLiveShaStore()
    this.createFiles()
    this.liveSegmentsInStorage = []

    await this.prepareDirectories()

    this.transcodingWrapper = this.buildTranscodingWrapper()

    this.transcodingWrapper.on('end', () => this.onTranscodedEnded())
    this.transcodingWrapper.on('error', () => this.onTranscodingError())

    await this.transcodingWrapper.run()

    this.filesWatcher = watch(this.outDirectory, { depth: 0 })

    this.watchMasterFile()
    this.watchTSFiles()
  }

  abort () {
    if (!this.transcodingWrapper) return

    this.aborted = true
    this.transcodingWrapper.abort()
  }

  destroy () {
    this.removeAllListeners()
    this.isAbleToUploadVideoWithCache.clear()
    this.hasClientSocketInBadHealthWithCache.clear()
  }

  private watchMasterFile () {
    this.filesWatcher.on('add', async path => {
      if (path !== join(this.outDirectory, this.streamingPlaylist.playlistFilename)) return
      if (this.masterPlaylistCreated === true) return

      try {
        if (this.streamingPlaylist.storage === VideoStorage.OBJECT_STORAGE) {
          const masterContent = await readFile(path, 'utf-8')
          logger.debug('Uploading live master playlist on object storage for %s', this.videoUUID, { masterContent, ...this.lTags() })

          const url = await storeHLSFileFromContent(this.streamingPlaylist, this.streamingPlaylist.playlistFilename, masterContent)

          this.streamingPlaylist.playlistUrl = url
        }

        this.streamingPlaylist.assignP2PMediaLoaderInfoHashes(this.videoLive.Video, this.allResolutions)

        await this.streamingPlaylist.save()
      } catch (err) {
        logger.error('Cannot update streaming playlist.', { err, ...this.lTags() })
      }

      this.masterPlaylistCreated = true

      logger.info('Master playlist file for %s has been created', this.videoUUID, this.lTags())
    })
  }

  private async parseM3U8Segments (srcDirectory: string, m3u8Path: string) {
    const m3u8Data = await readFile(m3u8Path)
    this.m3u8Parser = new M3u8Parser()
    this.m3u8Parser.push(m3u8Data)
    this.m3u8Parser.end()
    const m3u8Parsed = this.m3u8Parser.manifest
    const segmentPaths = m3u8Parsed.segments.map(segment => srcDirectory + '/' + segment.uri)
    return segmentPaths
  }

  private getUnavailableM3U8Segments (m3u8SegmentPaths: string[]) {
    const storedSegments = new Set(this.liveSegmentsInStorage)
    const unavailableM3U8Segments = new Set(m3u8SegmentPaths)
    for (const segment of m3u8SegmentPaths) {
      if (storedSegments.has(segment)) {
        unavailableM3U8Segments.delete(segment)
      }
    }
    return Array.from(unavailableM3U8Segments)
  }

  private async waitForUnavailableM3U8Segments (m3u8Path: string, m3u8SegmentPaths: string[], maxRetries = 30) {
    const retrySleepMs = 100
    let ackSleepMs = 0
    while (maxRetries) {
      const m3u8SegmentsUnavailable = this.getUnavailableM3U8Segments(m3u8SegmentPaths)
      logger.debug('Unavailable video segments from %s', m3u8Path, { unavailableSegments: m3u8SegmentsUnavailable })
      const segmentCount = m3u8SegmentsUnavailable.length
      if (segmentCount) {
        ackSleepMs += retrySleepMs
        maxRetries -= 1
        if (maxRetries > 0) {
          logger.info(
            'Video segment(s) from %s are unavailable, wait %s ms (segments: %s, ackumulated wait: %s ms, retries left: %s)...',
            m3u8Path, retrySleepMs, segmentCount, ackSleepMs, maxRetries
          )
          await new Promise(resolve => setTimeout(resolve, retrySleepMs))
        } else {
          logger.warn(
            'Max retries exceeded waiting for %s video segment(s) in storage, giving up (segments: %s, wait time: %s ms, retries left: 0)',
            m3u8Path, segmentCount, ackSleepMs, { unavailableSegments: m3u8SegmentsUnavailable }
          )
          break
        }
      } else {
        logger.info('All %s video segments from %s available in storage (total wait: %s ms)', m3u8SegmentPaths.length, m3u8Path, ackSleepMs)
        break
      }
    }
  }

  private watchM3U8File () {
    this.m3u8Watcher = watch(this.outDirectory + '/*.m3u8')

    const sendQueues = new Map<string, PQueue>()

    const onChangeOrAdd = async (m3u8Path: string) => {
      const m3u8SegmentPaths = await this.parseM3U8Segments(this.outDirectory, m3u8Path)
      logger.debug('Parsed %s video segments from %s', m3u8SegmentPaths.length, m3u8Path, { m3u8Segments: m3u8SegmentPaths })

      if (this.streamingPlaylist.storage !== VideoStorage.OBJECT_STORAGE) return

      try {
        if (!sendQueues.has(m3u8Path)) {
          sendQueues.set(m3u8Path, new PQueue({ concurrency: 1 }))
        }

        const queue = sendQueues.get(m3u8Path)
        await queue.add(async () => {
          await this.waitForUnavailableM3U8Segments(m3u8Path, m3u8SegmentPaths)
          return storeHLSFileFromPath(this.streamingPlaylist, m3u8Path)
        })
      } catch (err) {
        logger.error('Cannot store in object storage m3u8 file %s', m3u8Path, { err, ...this.lTags() })
      }
    }

    this.m3u8Watcher.on('change', onChangeOrAdd)
  }

  private watchTSFiles () {
    const startStreamDateTime = new Date().getTime()

    const addHandler = async (segmentPath: string) => {
      if (segmentPath.endsWith('.ts') !== true) return

      logger.debug('Live add handler of TS file %s.', segmentPath, this.lTags())

      const playlistId = this.getPlaylistIdFromTS(segmentPath)

      const segmentsToProcess = this.segmentsToProcessPerPlaylist[playlistId] || []
      this.processSegments(segmentsToProcess)

      this.segmentsToProcessPerPlaylist[playlistId] = [ segmentPath ]

      if (this.hasClientSocketInBadHealthWithCache(this.sessionId)) {
        this.emit('bad-socket-health', { videoUUID: this.videoUUID })
        return
      }

      // Duration constraint check
      if (this.isDurationConstraintValid(startStreamDateTime) !== true) {
        this.emit('duration-exceeded', { videoUUID: this.videoUUID })
        return
      }

      // Check user quota if the user enabled replay saving
      if (await this.isQuotaExceeded(segmentPath) === true) {
        this.emit('quota-exceeded', { videoUUID: this.videoUUID })
      }
    }

    const deleteHandler = async (segmentPath: string) => {
      if (segmentPath.endsWith('.ts') !== true) return

      logger.debug('Live delete handler of TS file %s.', segmentPath, this.lTags())

      try {
        await this.liveSegmentShaStore.removeSegmentSha(segmentPath)
      } catch (err) {
        logger.warn('Cannot remove segment sha %s from sha store', segmentPath, { err, ...this.lTags() })
      }

      if (this.streamingPlaylist.storage === VideoStorage.OBJECT_STORAGE) {
        try {
          await removeHLSFileObjectStorageByPath(this.streamingPlaylist, segmentPath)
          if (this.liveSegmentsInStorage.includes(segmentPath)) {
            const removedSegmentPath = this.liveSegmentsInStorage.splice(this.liveSegmentsInStorage.indexOf(segmentPath), 1)
            logger.debug('Removed segment %s from storage', removedSegmentPath, { liveSegmentsInStorage: this.liveSegmentsInStorage })
          } else {
            logger.warn('Removed segment %s is missing in video segments storage', segmentPath, {
              liveSegmentsInStorage: this.liveSegmentsInStorage
            })
          }
        } catch (err) {
          logger.error('Cannot remove segment %s from object storage', segmentPath, { err, ...this.lTags() })
        }
      }
    }

    this.filesWatcher.on('add', p => addHandler(p))
    this.filesWatcher.on('unlink', p => deleteHandler(p))
  }

  private async isQuotaExceeded (segmentPath: string) {
    if (this.saveReplay !== true) return false
    if (this.aborted) return false

    try {
      const segmentStat = await stat(segmentPath)

      LiveQuotaStore.Instance.addQuotaTo(this.user.id, this.sessionId, segmentStat.size)

      const canUpload = await this.isAbleToUploadVideoWithCache(this.user.id)

      return canUpload !== true
    } catch (err) {
      logger.error('Cannot stat %s or check quota of %d.', segmentPath, this.user.id, { err, ...this.lTags() })
    }
  }

  private createFiles () {
    for (let i = 0; i < this.allResolutions.length; i++) {
      const resolution = this.allResolutions[i]

      const file = new VideoFileModel({
        resolution,
        size: -1,
        extname: '.ts',
        infoHash: null,
        fps: this.fps,
        storage: this.streamingPlaylist.storage,
        videoStreamingPlaylistId: this.streamingPlaylist.id
      })

      VideoFileModel.customUpsert(file, 'streaming-playlist', null)
        .catch(err => logger.error('Cannot create file for live streaming.', { err, ...this.lTags() }))
    }
  }

  private async prepareDirectories () {
    await ensureDir(this.outDirectory)

    if (this.videoLive.saveReplay === true) {
      await ensureDir(this.replayDirectory)
    }
  }

  private isDurationConstraintValid (streamingStartTime: number) {
    const maxDuration = CONFIG.LIVE.MAX_DURATION
    // No limit
    if (maxDuration < 0) return true

    const now = new Date().getTime()
    const max = streamingStartTime + maxDuration

    return now <= max
  }

  private processSegments (segmentPaths: string[]) {
    mapSeries(segmentPaths, previousSegment => this.processSegment(previousSegment))
      .catch(err => {
        if (this.aborted) return

        logger.error('Cannot process segments', { err, ...this.lTags() })
      })
  }

  private async processSegment (segmentPath: string) {
    // Add sha hash of previous segments, because ffmpeg should have finished generating them
    await this.liveSegmentShaStore.addSegmentSha(segmentPath)

    if (this.saveReplay) {
      await this.addSegmentToReplay(segmentPath)
    }

    if (this.streamingPlaylist.storage === VideoStorage.OBJECT_STORAGE) {
      try {
        await storeHLSFileFromPath(this.streamingPlaylist, segmentPath)

        await this.processM3U8ToObjectStorage(segmentPath)
        this.liveSegmentsInStorage.push(segmentPath)
        logger.debug('Added segment %s to storage', segmentPath, { liveSegmentsInStorage: this.liveSegmentsInStorage })
      } catch (err) {
        logger.error('Cannot store TS segment %s in object storage', segmentPath, { err, ...this.lTags() })
      }
    }

    // Master playlist and segment JSON file are created, live is ready
    if (this.masterPlaylistCreated && !this.liveReady) {
      this.liveReady = true

      this.emit('live-ready', { videoUUID: this.videoUUID })
    }
  }

  private async processM3U8ToObjectStorage (segmentPath: string) {
    const m3u8Path = join(this.outDirectory, this.getPlaylistNameFromTS(segmentPath))

    logger.debug('Process M3U8 file %s.', m3u8Path, this.lTags())

    const segmentName = basename(segmentPath)

    const playlistContent = await readFile(m3u8Path, 'utf-8')
    // Remove new chunk references, that will be processed later
    const filteredPlaylistContent = playlistContent.substring(0, playlistContent.lastIndexOf(segmentName) + segmentName.length) + '\n'

    try {
      if (!this.objectStorageSendQueues.has(m3u8Path)) {
        this.objectStorageSendQueues.set(m3u8Path, new PQueue({ concurrency: 1 }))
      }

      const queue = this.objectStorageSendQueues.get(m3u8Path)
      await queue.add(() => storeHLSFileFromContent(this.streamingPlaylist, m3u8Path, filteredPlaylistContent))
    } catch (err) {
      logger.error('Cannot store in object storage m3u8 file %s', m3u8Path, { err, ...this.lTags() })
    }
  }

  private onTranscodingError () {
    this.emit('transcoding-error', ({ videoUUID: this.videoUUID }))
  }

  private onTranscodedEnded () {
    this.emit('transcoding-end', ({ videoUUID: this.videoUUID }))

    logger.info('RTMP transmuxing for video %s ended. Scheduling cleanup', this.inputLocalUrl, this.lTags())

    setTimeout(() => {
      // Wait latest segments generation, and close watchers

      const promise = this.filesWatcher?.close() || Promise.resolve()
      promise
        .then(() => {
          // Process remaining segments hash
          for (const key of Object.keys(this.segmentsToProcessPerPlaylist)) {
            this.processSegments(this.segmentsToProcessPerPlaylist[key])
          }
        })
        .catch(err => {
          logger.error(
            'Cannot close watchers of %s or process remaining hash segments.', this.outDirectory,
            { err, ...this.lTags() }
          )
        })

      this.emit('after-cleanup', { videoUUID: this.videoUUID })
    }, 1000)
  }

  private hasClientSocketInBadHealth (sessionId: string) {
    const rtmpSession = this.context.sessions.get(sessionId)

    if (!rtmpSession) {
      logger.warn('Cannot get session %s to check players socket health.', sessionId, this.lTags())
      return
    }

    for (const playerSessionId of rtmpSession.players) {
      const playerSession = this.context.sessions.get(playerSessionId)

      if (!playerSession) {
        logger.error('Cannot get player session %s to check socket health.', playerSession, this.lTags())
        continue
      }

      if (playerSession.socket.writableLength > VIDEO_LIVE.MAX_SOCKET_WAITING_DATA) {
        return true
      }
    }

    return false
  }

  private async addSegmentToReplay (segmentPath: string) {
    const segmentName = basename(segmentPath)
    const dest = join(this.replayDirectory, buildConcatenatedName(segmentName))

    try {
      const data = await readFile(segmentPath)

      await appendFile(dest, data)
    } catch (err) {
      logger.error('Cannot copy segment %s to replay directory.', segmentPath, { err, ...this.lTags() })
    }
  }

  private async createLivePlaylist (): Promise<MStreamingPlaylistVideo> {
    const playlist = await VideoStreamingPlaylistModel.loadOrGenerate(this.videoLive.Video)

    playlist.playlistFilename = generateHLSMasterPlaylistFilename(true)
    playlist.segmentsSha256Filename = generateHlsSha256SegmentsFilename(true)

    playlist.p2pMediaLoaderPeerVersion = P2P_MEDIA_LOADER_PEER_VERSION
    playlist.type = VideoStreamingPlaylistType.HLS

    playlist.storage = CONFIG.LIVE.USE_OBJECT_STORAGE
      ? VideoStorage.OBJECT_STORAGE
      : VideoStorage.FILE_SYSTEM

    return playlist.save()
  }

  private createLiveShaStore () {
    this.liveSegmentShaStore = new LiveSegmentShaStore({
      videoUUID: this.videoLive.Video.uuid,
      sha256Path: join(this.outDirectory, this.streamingPlaylist.segmentsSha256Filename),
      streamingPlaylist: this.streamingPlaylist,
      sendToObjectStorage: CONFIG.LIVE.USE_OBJECT_STORAGE
    })
  }

  private buildTranscodingWrapper () {
    const options = {
      streamingPlaylist: this.streamingPlaylist,
      videoLive: this.videoLive,

      lTags: this.lTags,

      sessionId: this.sessionId,
      inputLocalUrl: this.inputLocalUrl,
      inputPublicUrl: this.inputPublicUrl,

      toTranscode: this.allResolutions.map(resolution => ({
        resolution,
        fps: computeOutputFPS({ inputFPS: this.fps, resolution })
      })),

      fps: this.fps,
      bitrate: this.bitrate,
      ratio: this.ratio,
      hasAudio: this.hasAudio,

      segmentListSize: VIDEO_LIVE.SEGMENTS_LIST_SIZE,
      segmentDuration: getLiveSegmentTime(this.videoLive.latencyMode),

      outDirectory: this.outDirectory
    }

    return CONFIG.LIVE.TRANSCODING.ENABLED && CONFIG.LIVE.TRANSCODING.REMOTE_RUNNERS.ENABLED
      ? new RemoteTranscodingWrapper(options)
      : new FFmpegTranscodingWrapper(options)
  }

  private getPlaylistIdFromTS (segmentPath: string) {
    const playlistIdMatcher = /^([\d+])-/

    return basename(segmentPath).match(playlistIdMatcher)[1]
  }

  private getPlaylistNameFromTS (segmentPath: string) {
    return `${this.getPlaylistIdFromTS(segmentPath)}.m3u8`
  }
}

// ---------------------------------------------------------------------------

export {
  MuxingSession
}
