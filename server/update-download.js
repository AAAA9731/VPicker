import { createWriteStream, rmSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Stream to disk with byte progress; remove partial downloads on any failure. */
export async function downloadUpdate(url, destination, { size = 0, onProgress = () => {} } = {}) {
  let downloaded = 0
  try {
    const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'VPicker-updater' } })
    if (!response.ok || !response.body) throw new Error('下载失败：' + response.status)
    const length = Number(response.headers.get('content-length'))
    const total = Number.isSafeInteger(length) && length > 0 ? length : Number.isSafeInteger(size) && size > 0 ? size : 0
    let lastReport = Date.now()
    onProgress({ downloaded, total })
    const meter = new Transform({
      transform(chunk, encoding, done) {
        downloaded += chunk.length
        const now = Date.now()
        if (now - lastReport >= 100) {
          lastReport = now
          onProgress({ downloaded, total })
        }
        done(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination))
    if ((total && downloaded !== total) || (size > 0 && downloaded !== size)) throw new Error('下载的文件不完整')
    onProgress({ downloaded, total })
    return downloaded
  } catch (error) {
    rmSync(destination, { force: true })
    throw error
  }
}
