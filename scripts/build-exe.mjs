// 打包成单文件 exe：vite 构建网页 → esbuild 打包服务器 → Node SEA 把网页资源一起注入 node.exe 副本。
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { build } from 'esbuild'

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
const exeName = 'VPicker.exe'

console.log('1/4 构建网页…')
run('node', ['scripts/copy-wasm.mjs'])
run('npx', ['vite', 'build'])

console.log('2/4 打包服务器…')
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
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
})

console.log('3/4 生成 SEA 资源…')
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

console.log('4/4 注入到 exe…')
mkdirSync('release', { recursive: true })
const out = join('release', exeName)
copyFileSync(process.execPath, out)
run('npx', [
  'postject',
  out,
  'NODE_SEA_BLOB',
  'build/sea.blob',
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
])
console.log(`\n完成：${out}（${(statSync(out).size / 1048576).toFixed(0)} MB）`)
