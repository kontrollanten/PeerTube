/* SystemJS module definition */
declare var module: NodeModule

declare module '@silvermine/videojs-chromecast' {
  export default function (videojs: any, options: any): any
}
interface NodeModule {
  id: string
}

declare module 'markdown-it-emoji/light'
