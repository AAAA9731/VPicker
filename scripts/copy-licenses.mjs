import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** Include the licences and the provenance of the actual FFmpeg binary being bundled. */
export function copyLicenses({ binaryPath, ffmpegInfo = '', noticePath } = {}) {
  mkdirSync('public/licenses', { recursive: true })
  copyFileSync('LICENSE', 'public/licenses/VPicker-MIT.txt')
  const binary = binaryPath || process.env.FFMPEG_PATH || resolve('node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const customNotice = noticePath || process.env.FFMPEG_NOTICE_PATH
  let notice
  if (process.env.FFMPEG_PATH && !customNotice) {
    notice = 'Development FFmpeg is supplied via FFMPEG_PATH. Its provenance must be provided through FFMPEG_NOTICE_PATH before bundling.\n'
  } else if (customNotice) {
    notice = readFileSync(customNotice, 'utf8')
  } else {
    const readme = binary + '.README'
    notice = 'FFmpeg is an independent executable invoked by VPicker as a subprocess.\n' +
      'The bundled static binary is licensed under GPL-3.0-or-later. See GPL-3.0.txt.\n' +
      'Binary supplier and exact source/build provenance:\nhttps://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries\n\n' +
      (existsSync(readme) ? readFileSync(readme, 'utf8') : 'The binary has not yet been installed. Run npm install before building the executable.\n')
  }
  if (existsSync(binary)) notice += '\nSHA256: ' + createHash('sha256').update(readFileSync(binary)).digest('hex') + '\n'
  if (ffmpegInfo) notice += '\n' + ffmpegInfo
  writeFileSync('public/licenses/ffmpeg-build.txt', notice)
}
