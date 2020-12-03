import { registerTSPaths } from '../helpers/register-ts-paths'
registerTSPaths()

import * as program from 'commander'
import * as prompt from 'prompt'
import { accessSync, constants } from 'fs'
import { buildOriginallyPublishedAt, safeGetYoutubeDL } from '../helpers/youtube-dl'
import getPublishDate from '../helpers/youtube-get-publish-date'
import { buildCommonVideoOptions, getLogger, getServerCredentials, getAdminTokenOrDie } from './cli'
import { makeGetRequest, makePostBodyRequest } from '../../shared/extra-utils/requests/requests'
import { VideoPrivacy, VideoImportState } from '../../shared'

type UserInfo = {
  username: string
  password: string
}

const processOptions = {
  maxBuffer: Infinity
}

let command = program
  .name('import-videos')

command = buildCommonVideoOptions(command)

command
  .option('-u, --url <url>', 'Server url')
  .option('-U, --username <username>', 'Username')
  .option('-p, --password <token>', 'Password')
  .option('--target-url <targetUrl>', 'Video target URL')
  .option('--since <since>', 'Publication date (inclusive) since which the videos can be imported (YYYY-MM-DD)', parseDate)
  .option('--until <until>', 'Publication date (inclusive) until which the videos can be imported (YYYY-MM-DD)', parseDate)
  .option('--first <first>', 'Process first n elements of returned playlist')
  .option('--last <last>', 'Process last n elements of returned playlist')
  .option('-T, --tmpdir <tmpdir>', 'Working directory', __dirname)
  .usage("[global options] [ -- youtube-dl options]")
  .parse(process.argv)

const log = getLogger(program['verbose'])

getServerCredentials(command)
  .then(({ url, username, password }) => {
    if (!program['targetUrl']) {
      exitError('--target-url field is required.')
    }

    try {
      accessSync(program['tmpdir'], constants.R_OK | constants.W_OK)
    } catch (e) {
      exitError('--tmpdir %s: directory does not exist or is not accessible', program['tmpdir'])
    }

    url = normalizeTargetUrl(url)
    program['targetUrl'] = normalizeTargetUrl(program['targetUrl'])

    const user = { username, password }

    run(url, user)
      .catch(err => exitError(err))
  })
  .catch(err => console.error(err))

async function run (url: string, user: UserInfo) {
  if (!user.password) {
    user.password = await promptPassword()
  }

  const youtubeDL = await safeGetYoutubeDL()

  let info = await getYoutubeDLInfo(youtubeDL, program['targetUrl'], command.args)

  if (info?.title === 'Uploads') {
    console.log('Fixing URL to %s.', info.url)

    info = await getYoutubeDLInfo(youtubeDL, info.url, command.args)
  }

  let infoArray: any[]

  // Normalize utf8 fields
  infoArray = [].concat(info)
  if (program['first']) {
    infoArray = infoArray.slice(0, program['first'])
  } else if (program['last']) {
    infoArray = infoArray.slice(-program['last'])
  }
  infoArray = infoArray.map(i => normalizeObject(i))

  log.info('Will import %d videos.\n', infoArray.length)

  let originallyPublishedAtItems = []

  for (let i = 0; i < infoArray.length; i += 50) {
    const data = await getPublishDate(
      infoArray
        .slice(i, i + 50)
        .map(i => i.id)
        .join(',')
    )

    originallyPublishedAtItems = originallyPublishedAtItems.concat(data.items)
  }

  const { url: serverUrl, username, password } = await getServerCredentials(program)
  const accessToken = await getAdminTokenOrDie(serverUrl, username, password)

  log.info('Retrieving list of previous imported videos...')

  let importedVideos = []
  let done = false

  while (!done) {
    const { body } = await makeGetRequest({
      url: serverUrl,
      path: `/api/v1/users/me/videos/imports?sort=-createdAt&count=100&start=${importedVideos.length}`,
      statusCodeExpected: 200,
      token: accessToken
    })

    importedVideos = importedVideos.concat(body.data)

    done = body.total === importedVideos.length
  }

  for (const info of infoArray) {
    const apiInfo = originallyPublishedAtItems.find(o => o.id === info.id)

    if (!apiInfo) {
      console.error(`Can't find publish date for ${info.id}. Skipping.`)
      continue
    }

    try {
      await processVideo({
        ptCredentials: {
          accessToken,
          serverUrl,
        },
        cwd: program['tmpdir'],
        importedVideos,
        originallyPublishedAt: apiInfo.snippet.publishedAt,
        url,
        user,
        youtubeInfo: info
      })
    } catch (err) {
      console.error('Cannot process video.', { info, url })
    }
  }

  log.info('Video/s for user %s imported: %s', user.username, program['targetUrl'])
  process.exit(0)
}

function processVideo (parameters: {
  cwd: string
  importedVideos: any[]
  originallyPublishedAt: string
  url: string
  user: { username: string, password: string }
  ptCredentials: { accessToken: string, serverUrl: string }
  youtubeInfo: any
}) {
  const { importedVideos, originallyPublishedAt, ptCredentials: { accessToken, serverUrl }, youtubeInfo } = parameters
  const youtubeUrl = buildUrl(youtubeInfo)

  return new Promise(async res => {
    log.info('############################################################\n')

    log.debug('Fetching object.', youtubeInfo)

    const videoInfo = await fetchObject(youtubeInfo)
    log.debug('Fetched object.', videoInfo)

    if (program['since']) {
      if (buildOriginallyPublishedAt(videoInfo).getTime() < program['since'].getTime()) {
        log.info('Video "%s" has been published before "%s", don\'t upload it.\n',
          videoInfo.title, formatDate(program['since']))
        return res()
      }
    }
    if (program['until']) {
      if (buildOriginallyPublishedAt(videoInfo).getTime() > program['until'].getTime()) {
        log.info('Video "%s" has been published after "%s", don\'t upload it.\n',
          videoInfo.title, formatDate(program['until']))
        return res()
      }
    }

    log.info('Checking if user has already imported the video...')

    if (
      importedVideos.find(v =>
        v.targetUrl === youtubeUrl &&
          !!v.video &&
          [ VideoImportState.PENDING, VideoImportState.SUCCESS ].includes(v.state.id))
    ) {
      log.info('Video "%s" already exists, don\'t reupload it.\n', videoInfo.title)
      return res()
    }

    const { body: { videoChannels: [ videoChannel ] } } = await makeGetRequest({
      url: serverUrl,
      path: '/api/v1/users/me',
      statusCodeExpected: 200,
      token: accessToken
    })

    log.info('Importing video "%s to channel %s"...', videoInfo.title, videoChannel.name)

    await makePostBodyRequest({
      url: serverUrl,
      path: '/api/v1/videos/imports',
      token: accessToken,
      fields: {
        channelId: videoChannel.id,
        originallyPublishedAt,
        privacy: VideoPrivacy.PUBLIC,
        targetUrl: youtubeUrl
      },
      statusCodeExpected: 200
    })

    return res()
  })
}

function normalizeObject (obj: any) {
  const newObj: any = {}

  for (const key of Object.keys(obj)) {
    // Deprecated key
    if (key === 'resolution') continue

    const value = obj[key]

    if (typeof value === 'string') {
      newObj[key] = value.normalize()
    } else {
      newObj[key] = value
    }
  }

  return newObj
}

function fetchObject (info: any) {
  const url = buildUrl(info)

  return new Promise<any>(async (res, rej) => {
    const youtubeDL = await safeGetYoutubeDL()
    youtubeDL.getInfo(url, undefined, processOptions, (err, videoInfo) => {
      if (err) return rej(err)

      const videoInfoWithUrl = Object.assign(videoInfo, { url })
      return res(normalizeObject(videoInfoWithUrl))
    })
  })
}

function buildUrl (info: any) {
  const webpageUrl = info.webpage_url as string
  if (webpageUrl?.match(/^https?:\/\//)) return webpageUrl

  const url = info.url as string
  if (url?.match(/^https?:\/\//)) return url

  // It seems youtube-dl does not return the video url
  return 'https://www.youtube.com/watch?v=' + info.id
}

function normalizeTargetUrl (url: string) {
  let normalizedUrl = url.replace(/\/+$/, '')

  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl
  }

  return normalizedUrl
}

async function promptPassword () {
  return new Promise<string>((res, rej) => {
    prompt.start()
    const schema = {
      properties: {
        password: {
          hidden: true,
          required: true
        }
      }
    }
    prompt.get(schema, function (err, result) {
      if (err) {
        return rej(err)
      }
      return res(result.password)
    })
  })
}

function parseDate (dateAsStr: string): Date {
  if (!/\d{4}-\d{2}-\d{2}/.test(dateAsStr)) {
    exitError(`Invalid date passed: ${dateAsStr}. Expected format: YYYY-MM-DD. See help for usage.`)
  }
  const date = new Date(dateAsStr)
  date.setHours(0, 0, 0)
  if (isNaN(date.getTime())) {
    exitError(`Invalid date passed: ${dateAsStr}. See help for usage.`)
  }
  return date
}

function formatDate (date: Date): string {
  return date.toISOString().split('T')[0]
}

function exitError (message: string, ...meta: any[]) {
  // use console.error instead of log.error here
  console.error(message, ...meta)
  process.exit(-1)
}

function getYoutubeDLInfo (youtubeDL: any, url: string, args: string[]) {
  return new Promise<any>((res, rej) => {
    const options = [ '-j', '--flat-playlist', '--playlist-reverse', ...args ]

    youtubeDL.getInfo(url, options, processOptions, async (err, info) => {
      if (err) return rej(err)

      return res(info)
    })
  })
}
