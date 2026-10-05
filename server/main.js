// 本地服务器：提供打包好的网页，在命令行里反馈状态，所有页面都关闭后自动退出。
// 打包成 exe 时静态文件从 SEA 资源里读取；直接 `node server/main.js` 时读取 dist/。
import http from 'node:http'
import { exec, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAsset, isSea } from 'node:sea'

const APP = 'VPicker 立绘 VP 选择器'
const START_PORT = 5173
const IDLE_EXIT_MS = 5000 // 最后一个页面断开后，等待多久退出（刷新页面不会误杀）
const NEVER_OPENED_MS = 120000 // 启动后一直没有页面连接则退出

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const portArg = args.find((a) => a.startsWith('--port='))
const wantPort = portArg ? Number(portArg.slice(7)) : START_PORT

if (process.platform === 'win32') {
  // 命令行窗口默认是 GBK 代码页，切到 UTF-8 才能正确显示中文
  spawnSync('chcp.com', ['65001'], { stdio: 'ignore' })
  process.title = APP
}

const C = { dim: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', off: '\x1b[0m' }
const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
function log(tag, text, color = '') {
  console.log(`${C.dim}${time()}${C.off} ${color}${tag}${C.off} ${text}`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
function readAsset(key) {
  if (isSea()) {
    try {
      return Buffer.from(getAsset(key))
    } catch {
      return null
    }
  }
  const p = normalize(join(distDir, key))
  if (!p.startsWith(normalize(distDir)) || !existsSync(p)) return null
  return readFileSync(p)
}

// ───────────── 页面连接（用于判断标签页是否还开着） ─────────────
const clients = new Set()
let everConnected = false
let idleTimer = null

function onClientsChanged() {
  if (clients.size > 0) {
    everConnected = true
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    log('页面', `已连接（当前 ${clients.size} 个标签页）`, C.green)
  } else if (everConnected) {
    log('页面', `已关闭，${IDLE_EXIT_MS / 1000} 秒内没有重新打开就自动退出`, C.yellow)
    idleTimer = setTimeout(() => shutdown('所有页面都已关闭'), IDLE_EXIT_MS)
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/__events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(':ok\n\n')
    const ping = setInterval(() => res.write(':ping\n\n'), 15000)
    clients.add(res)
    onClientsChanged()
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
      onClientsChanged()
    })
    return
  }
  if (url.pathname === '/__log' && req.method === 'POST') {
    let body = ''
    req.on('data', (d) => {
      if (body.length < 4096) body += d
    })
    req.on('end', () => {
      const t = body.trim()
      if (t.startsWith('错误')) log('页面', t, C.red)
      else if (t) log('页面', t)
      res.writeHead(204).end()
    })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  let key = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  let data = readAsset(key)
  if (!data) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found')
    log('404', url.pathname, C.red)
    return
  }
  if (key === 'index.html') {
    // 告诉页面它运行在本地服务器上，需要保持心跳连接
    data = Buffer.from(data.toString('utf8').replace('<head>', '<head>\n  <meta name="aic-server" content="1" />'))
  }
  res.writeHead(200, { 'content-type': MIME[extname(key)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : data)
})

let exiting = false
function shutdown(reason) {
  if (exiting) return
  exiting = true
  log('退出', reason, C.cyan)
  for (const c of clients) c.end()
  server.close()
  setTimeout(() => process.exit(0), 600)
}
process.on('SIGINT', () => shutdown('收到 Ctrl+C'))
process.on('SIGTERM', () => shutdown('收到终止信号'))

function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 30) listen(port + 1, tries + 1)
    else {
      log('错误', '无法启动服务器：' + e.message, C.red)
      setTimeout(() => process.exit(1), 3000)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${server.address().port}/`
    console.log(`\n  ${C.cyan}${APP}${C.off}`)
    console.log(`  地址：${C.green}${url}${C.off}`)
    console.log(`  关闭浏览器标签页后，本窗口会自动退出（也可以按 Ctrl+C）。\n`)
    log('服务', `已启动，端口 ${server.address().port}`, C.green)
    if (!noOpen) {
      exec(`start "" "${url}"`, (err) => {
        if (err) log('提示', `没能自动打开浏览器，请手动访问 ${url}`, C.yellow)
        else log('浏览器', '已打开，请在页面里选择游戏的 StreamingAssets 文件夹')
      })
    }
    setTimeout(() => {
      if (!everConnected) shutdown('启动后一直没有页面连接')
    }, NEVER_OPENED_MS)
  })
}
listen(wantPort)
