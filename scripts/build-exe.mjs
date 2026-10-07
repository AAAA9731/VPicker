// 打包成单文件可执行程序：vite 构建网页 → esbuild 打包服务器 → Node SEA 把网页资源一起注入 node 可执行文件的副本。
// 支持 Windows 和 macOS（在对应系统上运行即可生成对应版本）。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { copyLicenses } from './copy-licenses.mjs'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true })
const exeName = isWin ? 'VPicker.exe' : 'VPicker'
const seaDir = 'build/sea'
mkdirSync(seaDir, { recursive: true })
const defaultFFmpeg = resolve('node_modules/ffmpeg-static', isWin ? 'ffmpeg.exe' : 'ffmpeg')
const ffmpeg = process.env.FFMPEG_PATH || defaultFFmpeg
if (!existsSync(ffmpeg)) throw Error('缺少静态 FFmpeg，请先 npm install；也可设置 FFMPEG_PATH 和 FFMPEG_NOTICE_PATH')
if (process.env.FFMPEG_PATH && !process.env.FFMPEG_NOTICE_PATH) throw Error('自定义 FFmpeg 须用 FFMPEG_NOTICE_PATH 提供匹配此二进制的许可证、来源及源码信息')
const ffmpegBytes = readFileSync(ffmpeg)
const ffmpegInfo = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true })
if (/--enable-nonfree\b/.test(ffmpegInfo)) throw Error('不能打包标有 nonfree 的 FFmpeg')
const encodingInfo = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true })
if (!/\blibx264\b/.test(encodingInfo) || !/\blibvpx-vp9\b/.test(encodingInfo)) throw Error('静态 FFmpeg 需要 libx264 和 libvpx-vp9 编码器')
writeFileSync(join(seaDir, 'ffmpeg.gz'), gzipSync(ffmpegBytes, { level: 9 }))

console.log('1/5 构建网页…')
run(process.execPath, ['scripts/copy-wasm.mjs'])
copyLicenses({ binaryPath: ffmpeg, ffmpegInfo, noticePath: process.env.FFMPEG_NOTICE_PATH })
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])

console.log('2/5 打包服务器…')
await build({
  entryPoints: ['server/main.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: join(seaDir, 'server.cjs'),
  external: ['node:sea'],
  define: {
    'import.meta.url': '__import_meta_url',
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version),
  },
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
})

console.log('3/5 生成 SEA 资源…')
const assets = {}
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else assets[relative('dist', p).replaceAll('\\', '/')] = p
  }
}
walk('dist')
assets['tools/ffmpeg.gz'] = join(seaDir, 'ffmpeg.gz')
writeFileSync(
  join(seaDir, 'sea-config.json'),
  JSON.stringify({ main: join(seaDir, 'server.cjs'), output: join(seaDir, 'sea.blob'), disableExperimentalSEAWarning: true, assets }, null, 2)
)
run(process.execPath, ['--experimental-sea-config', join(seaDir, 'sea-config.json')])

console.log('4/5 注入到可执行文件…')
mkdirSync('release', { recursive: true })
const out = join('release', exeName)
copyFileSync(process.execPath, out)
// macOS 的 node 带有签名，注入前必须先去掉，注入后做 ad-hoc 重新签名（Apple 芯片要求可执行文件有签名才能运行）
if (isMac) run('codesign', ['--remove-signature', out])
run(process.execPath, [
  'node_modules/postject/dist/cli.js',
  out,
  'NODE_SEA_BLOB',
  join(seaDir, 'sea.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
])
if (isMac) run('codesign', ['--sign', '-', out])

console.log('5/5 打包发布文件…')
let dist = out
if (isMac) {
  // zip 能保留可执行权限；直接分发裸二进制会丢失
  dist = join('release', `VPicker-macos-${process.arch}.zip`)
  run('zip', ['-j', dist, out])
}
console.log(`\n完成：${dist}（${(statSync(dist).size / 1048576).toFixed(0)} MB）`)
