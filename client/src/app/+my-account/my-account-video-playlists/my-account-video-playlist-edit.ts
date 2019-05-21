import { FormReactive } from '@app/shared'
import { VideoPlaylist } from '@shared/models/videos/playlist/video-playlist.model'

export abstract class MyAccountVideoPlaylistEdit extends FormReactive {
  // Declare it here to avoid errors in create template
  videoPlaylistToUpdate: VideoPlaylist
  userVideoChannels: { id: number, label: string }[] = []

  abstract isCreation (): boolean
  abstract getFormButtonTitle (): string
}
