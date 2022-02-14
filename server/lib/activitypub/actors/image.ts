import { Transaction } from 'sequelize/types'
import { logger } from '@server/helpers/logger'
import { ActorImageModel } from '@server/models/actor/actor-image'
import { MActorImage, MActorImages } from '@server/types/models'
import { ActorImageType } from '@shared/models'

type ImageInfo = {
  name: string
  fileUrl: string
  height: number
  width: number
  onDisk?: boolean
}

async function updateActorImageInstance (actor: MActorImages, type: ActorImageType, imagesInfo: ImageInfo[] | null, t: Transaction) {
  const avatarsOrBanners = type === ActorImageType.AVATAR ? actor.Avatars : actor.Banners

  await Promise.all(imagesInfo.map(async imageInfo => {
    const oldImageModel = avatarsOrBanners.find(i => i.width === imageInfo.width)

    if (imageInfo?.fileUrl && oldImageModel.fileUrl === imageInfo.fileUrl) {
      logger.info('Dont update avatar/banner since the fileUrl did not change.')
      return actor
    }

    if (oldImageModel) {
      try {
        await oldImageModel.destroy({ transaction: t })

        setActorImage(actor, type, null)
      } catch (err) {
        logger.error('Cannot remove old actor image of actor %s.', actor.url, { err })
      }
    }

    const imageModel = await ActorImageModel.create({
      filename: imageInfo.name,
      onDisk: imageInfo.onDisk ?? false,
      fileUrl: imageInfo.fileUrl,
      height: imageInfo.height,
      width: imageInfo.width,
      type,
      actorId: actor.id
    }, { transaction: t })

    setActorImage(actor, type, imageModel)
  }))

  return actor
}

async function deleteActorImageInstance (actor: MActorImages, type: ActorImageType, t: Transaction) {
  try {
    switch (type) {
      case ActorImageType.AVATAR:
        for (const avatar of actor.Avatars) {
          await avatar.destroy({ transaction: t })
        }

        actor.Avatars = []
        break
      case ActorImageType.BANNER:
        for (const banner of actor.Banners) {
          await banner.destroy({ transaction: t })
        }

        actor.Banners = []
        break
    }
  } catch (err) {
    logger.error('Cannot remove old image of actor %s.', actor.url, { err })
  }

  return actor
}

// ---------------------------------------------------------------------------

export {
  ImageInfo,

  updateActorImageInstance,
  deleteActorImageInstance
}

// ---------------------------------------------------------------------------

function setActorImage (actorModel: MActorImages, type: ActorImageType, imageModel: MActorImage) {
  switch (type) {
    case ActorImageType.AVATAR:
      actorModel.Avatars = [ ...actorModel.Avatars.filter(a => a.width !== imageModel.width), imageModel ]
      break
    case ActorImageType.BANNER:
      actorModel.Banners = [ ...actorModel.Banners.filter(a => a.width !== imageModel.width), imageModel ]
      break
  }

  return actorModel
}
