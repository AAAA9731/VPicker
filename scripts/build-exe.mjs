// 打包成单文件可执行程序：vite 构建网页 → esbuild 打包服务器 → Node SEA 把网页资源一起注入 node 可执行文件的副本。
// 支持 Windows 和 macOS（在对应系统上运行即可生成对应版本）。
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { build } from 'esbuild'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: isWin })
const exeName = isWin ? 'VPicker.exe' : 'VPicker'

console.log('1/5 构建网页…')
run('node', ['scripts/copy-wasm.mjs'])
run('npx', ['vite', 'build'])

console.log('2/5 打包服务器…')
rmSync('build', { recursive: true, force: true })
mkdirSync('build', { recursive: true })
await build({
  entryPoints: ['server/main.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: 'build/server.cjs',
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
writeFileSync(
  'build/sea-config.json',
  JSON.stringify({ main: 'build/server.cjs', output: 'build/sea.blob', disableExperimentalSEAWarning: true, assets }, null, 2)
)
run('node', ['--experimental-sea-config', 'build/sea-config.json'])

console.log('4/5 注入到可执行文件…')
rmSync('release', { recursive: true, force: true })
mkdirSync('release', { recursive: true })
const out = join('release', exeName)
copyFileSync(process.execPath, out)
// macOS 的 node 带有签名，注入前必须先去掉，注入后做 ad-hoc 重新签名（Apple 芯片要求可执行文件有签名才能运行）
if (isMac) run('codesign', ['--remove-signature', out])
run('npx', [
  'postject',
  out,
  'NODE_SEA_BLOB',
  'build/sea.blob',
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
