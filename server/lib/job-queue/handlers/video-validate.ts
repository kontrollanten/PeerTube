import { Job } from 'bull'
import { checkValidity } from '@server/helpers/ffmpeg/ffmpeg-validate'
import { logger, loggerTagsFactory } from '@server/helpers/logger'
import { VideoModel } from '@server/models/video/video'
import { VideoStreamingPlaylistType, VideoValidatePayload } from '@shared/models'
import { moveToFailedTranscodingState, moveToNextState } from '@server/lib/video-state'
import { Notifier } from '@server/lib/notifier'
import { getHLSDirectory } from '@server/lib/paths'
import { join } from 'path'
import { CONFIG } from '@server/initializers/config'
import { JobQueue } from '..'
import { VideoJobInfoModel } from '@server/models/video/video-job-info'
import { retryTransactionWrapper } from '@server/helpers/database-utils'

const lTags = loggerTagsFactory('transcoding')

const getVideoFile = (video, type, resolution) => {
  switch (type) {
    case 'hls': {
      const videoFile = video.VideoStreamingPlaylists.find(v => v.type === VideoStreamingPlaylistType.HLS)
      .VideoFiles.find(f => f.resolution === resolution)
      return join(getHLSDirectory(video), videoFile.filename)
    }
    case 'webtorrent': {
      const videoFile = video.VideoFiles.find(f => f.resolution === resolution)
      return join(CONFIG.STORAGE.VIDEOS_DIR, videoFile.filename)
    }
    default:
      throw Error(`Couldn't find file for video ${video.uuid} and type ${type}`)
  }
}

async function processVideoValidate (job: Job) {
  const payload = job.data as VideoValidatePayload

  logger.info('Processing %s video validate for resolution %d at video %s',
    payload.type,
    payload.resolution,
    payload.videoUUID,
    lTags(payload.videoUUID)
  )

  const video = await VideoModel.loadAndPopulateAccountAndServerAndTags(payload.videoUUID)

  try {
    await checkValidity({
      job,
      path: getVideoFile(video, payload.type, payload.resolution)
    })
    await VideoJobInfoModel.decrease(video.uuid, 'pendingValidateVideo')
    await retryTransactionWrapper(moveToNextState, video, payload.isNewVideo)
  } catch (err) {
    logger.error('Video validate failed for resolution %s in video %s',
      payload.resolution,
      payload.videoUUID,
      lTags(payload.videoUUID)
    )
    await VideoJobInfoModel.decrease(video.uuid, 'pendingValidateVideo')
    await moveToFailedTranscodingState(video)
    Notifier.Instance.notifyOnVideoValidationFailed(video)

    const remainingJobs = await JobQueue.Instance.getJobs('validate-video-file', [ 'active', 'delayed', 'waiting' ])

    logger.debug('Removing remaining %d validate-video-file jobs', remainingJobs.length)

    for (const job of remainingJobs.filter(j => j.data.videoUUID === payload.videoUUID)) {
      await job.remove()
    }
  }
}

export {
  processVideoValidate
}
