export const enum VideoState {
  PUBLISHED = 1,
  TO_TRANSCODE = 2,
  TO_IMPORT = 3,
  WAITING_FOR_LIVE = 4,
  LIVE_ENDED = 5,
  TO_MOVE_TO_EXTERNAL_STORAGE = 6,
  TO_MIGRATE_TO_EXTERNAL_STORAGE = 7
}
