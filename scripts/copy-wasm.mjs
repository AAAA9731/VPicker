// 把 texture2ddecoder-wasm 的 wasm 文件复制到 public/wasm，供浏览器端按需加载。
import { cpSync, mkdirSync, existsSync } from 'node:fs'

const src = 'node_modules/texture2ddecoder-wasm/wasm'
if (!existsSync(src)) {
  console.error('找不到 ' + src + '，请先运行 npm install')
  process.exit(1)
}
mkdirSync('public/wasm', { recursive: true })
cpSync(src, 'public/wasm', { recursive: true })
console.log('已复制 wasm 到 public/wasm')
