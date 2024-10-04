const apiUrl = typeof window === 'undefined' ? process.env.API_URL : ''

export const environment = {
  production: true,
  hmr: false,
  apiUrl,
  originServerUrl: ''
}
