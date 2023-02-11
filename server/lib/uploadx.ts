import express from 'express'
import { buildLogger } from '@server/helpers/logger'
import { getResumableUploadPath } from '@server/helpers/upload'
import { CONFIG } from '@server/initializers/config'
import { File, LogLevel, Uploadx } from '@uploadx/core'
import { S3Storage } from '@uploadx/s3'
import { getEndpoint } from './object-storage/shared'

const logger = buildLogger('uploadx')

const uploadxLogger = {
  logLevel: CONFIG.LOG.LEVEL as LogLevel,
  debug: logger.debug.bind(logger),
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger)
}

const userIdentifier = (_, res: express.Response) => {
  if (!res.locals.oauth) return undefined

  return res.locals.oauth.token.user.id + ''
}

let uploadx: Uploadx<Readonly<File>>

if (CONFIG.OBJECT_STORAGE.ENABLED) {
  uploadx = new Uploadx({
    storage: new S3Storage({
      bucket: CONFIG.OBJECT_STORAGE.VIDEOS.BUCKET_NAME,
      credentials: {
        accessKeyId: CONFIG.OBJECT_STORAGE.CREDENTIALS.ACCESS_KEY_ID,
        secretAccessKey: CONFIG.OBJECT_STORAGE.CREDENTIALS.SECRET_ACCESS_KEY
      },
      clientDirectUpload: true,
      endpoint: getEndpoint(),
      expiration: { maxAge: '8h', purgeInterval: '15min' },
      forcePathStyle: true,
      logger: {
        ...uploadxLogger,
        debug: (args) => {
          uploadxLogger.debug(JSON.stringify(args))
        },
        info: (args) => {
          uploadxLogger.info(JSON.stringify(args))
        }
      },
      userIdentifier,
      partSize: CONFIG.CLIENT.VIDEOS.RESUMABLE_UPLOAD.MAX_CHUNK_SIZE
    })
  })
} else {
  uploadx = new Uploadx({
    directory: getResumableUploadPath(),
    expiration: { maxAge: undefined, rolling: true },
    // Could be big with thumbnails/previews
    maxMetadataSize: '10MB',
    logger: uploadxLogger,
    userIdentifier
  })
}

export {
  uploadx
}
