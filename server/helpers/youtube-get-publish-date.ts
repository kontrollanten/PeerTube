const fetch = require('node-fetch')

let apiKey

export default async (ids) => {
  if (!apiKey) {
    const content = await fetch('https://citizenevidence.amnestyusa.org/')
      .then(res => res.text())

    apiKey = content
      .split('\n')
      .find(line => line.includes('theUrl ='))
      .match(/'(.*?)'/g)[1]
      .split('key=')[1]
      .slice(0, -1)
  }

  const idsString = ids.split(',')

  return await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${idsString}&part=snippet&key=${apiKey}&maxResults=50`)
    .then(res => res.json())
}
