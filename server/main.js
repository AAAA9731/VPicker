// 本地服务器：提供打包好的网页，在命令行里反馈状态，所有页面都关闭后自动退出。
// 打包成 exe 时静态文件从 SEA 资源里读取；直接 `node server/main.js` 时读取 dist/。
import http from 'node:http'
import { exec, spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAsset, isSea } from 'node:sea'
import { PXL_FILES as WANTED, SKIP_GAME_DIRS as SKIP_DIR, spineFileKey } from '../src/game-index.js'
import { createVideoService } from './video.js'

const APP = 'VPicker 游戏素材提取工具'
const START_PORT = 5173
const IDLE_EXIT_MS = 5000 // 最后一个页面断开后，等待多久退出（刷新页面不会误杀）
const NEVER_OPENED_MS = 120000 // 启动后一直没有页面连接则退出

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const isRestart = args.includes('--restart') // 更新后由旧进程拉起：旧进程还没释放端口时，原端口重试而不是换端口
const portArg = args.find((a) => a.startsWith('--port='))
const wantPort = portArg ? Number(portArg.slice(7)) : START_PORT

// 游戏目录：命令行 `--dir=路径`（或直接把文件夹拖到 exe 上 / 第一个不带 -- 的参数）；没有的话用上次成功打开的路径
const cliDir = args.find((a) => a.startsWith('--dir='))?.slice(6) ?? args.find((a) => !a.startsWith('--'))
const configPath =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'VPicker', 'config.json')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'VPicker', 'config.json')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'VPicker', 'config.json')
function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}
function saveConfig(cfg) {
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  } catch (e) {
    log('提示', '没能保存上次的路径：' + e.message, C.yellow)
  }
}

// ───────────── 自动更新（检查 GitHub Releases） ─────────────
const REPO = 'AAAA9731/VPicker'
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : (() => {
        try {
          return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version
        } catch {
          return '0.0.0'
        }
      })()
const verParts = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
function isNewer(a, b) {
  const x = verParts(a)
  const y = verParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}
const assetName = process.platform === 'win32' ? 'VPicker.exe' : process.platform === 'darwin' ? `VPicker-macos-${process.arch}.zip` : null
// 只有打包后的 Windows exe 才能原地替换自己；其他情况只提示并给出下载页
const canSelfUpdate = isSea() && process.platform === 'win32'
let updateCache = null
async function checkUpdate() {
  if (updateCache && Date.now() - updateCache.at < 3600_000) return updateCache.info
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'VPicker-updater' },
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) throw new Error('GitHub 返回 ' + r.status)
  const j = await r.json()
  const asset = (j.assets ?? []).find((a) => a.name === assetName)
  const latest = String(j.tag_name ?? '').replace(/^v/i, '')
  const info = {
    current: APP_VERSION,
    latest,
    newer: isNewer(j.tag_name ?? '0', APP_VERSION),
    notes: String(j.body ?? '').slice(0, 1500),
    url: j.html_url,
    canSelfUpdate: canSelfUpdate && !!asset,
    assetUrl: asset?.browser_download_url ?? null,
    ignored: loadConfig().ignoredVersion === latest,
  }
  updateCache = { at: Date.now(), info }
  return info
}
async function applyUpdate() {
  const info = await checkUpdate()
  if (!info.newer || !info.canSelfUpdate) throw new Error('当前没有可自动安装的更新')
  const u = new URL(info.assetUrl)
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.startsWith(`/${REPO}/releases/download/`)) throw new Error('下载地址不可信')
  const exe = process.execPath
  const tmp = exe + '.new'
  log('更新', `正在下载 ${info.latest} …`, C.cyan)
  const r = await fetch(info.assetUrl, { redirect: 'follow', headers: { 'user-agent': 'VPicker-updater' } })
  if (!r.ok || !r.body) throw new Error('下载失败：' + r.status)
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp))
  if (statSync(tmp).size < 1024 * 1024) {
    rmSync(tmp, { force: true })
    throw new Error('下载的文件不完整')
  }
  removeOld()
  renameSync(exe, exe + '.old') // Windows 允许重命名正在运行的 exe
  try {
    renameSync(tmp, exe)
  } catch (e) {
    renameSync(exe + '.old', exe)
    throw e
  }
  log('更新', `已更新到 ${info.latest}，正在重启…`, C.green)
}
function restartSelf() {
  const child = spawn(process.execPath, ['--no-open', '--restart', `--port=${server.address().port}`], { detached: true, stdio: 'ignore' })
  child.unref()
  shutdown('更新完成，已启动新版本')
}
// 清理上次更新留下的旧文件；旧进程可能还没退出（文件被占用），失败就留给下次
function removeOld() {
  try {
    rmSync(process.execPath + '.old', { force: true })
  } catch {}
}
if (canSelfUpdate) {
  removeOld()
  setTimeout(removeOld, 8000)
}

// 与 src/loader.js 的 WANTED / SKIP_DIR 保持一致
/** 当前选定目录里的文件索引：文件名 → 完整路径 */
let gameIndex = new Map()
/** SimplePatch 的自定义图片文件夹（StreamingAssets/SimplePatch_pic）里的 PNG：相对路径 → 完整路径 */
const PIC_DIR = 'SimplePatch_pic'
const SAFE_PIC = /^[A-Za-z0-9_\-.]+\.png$/i
const MAX_PIC_BYTES = 50 * 1024 * 1024
let picIndex = new Map()
/** SimplePatch_pic 文件夹本身的完整路径（导入 / 重命名只在这里面操作） */
let picRoot = ''
function scanDir(dir, out = new Map(), depth = 0, pics = { found: false, files: new Map(), root: '' }, picRel = null) {
  if (picRel === null && basename(dir) === PIC_DIR) {
    pics.found = true
    pics.root = dir
    picRel = ''
  }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (picRel !== null) {
        if (depth < 8) scanDir(p, out, depth + 1, pics, picRel + name + '/')
      } else if (name === PIC_DIR) {
        pics.found = true
        pics.root = p
        scanDir(p, out, depth + 1, pics, '')
      } else if (depth < 8 && !SKIP_DIR.has(name)) scanDir(p, out, depth + 1, pics)
    } else if (picRel !== null) {
      if (/\.png$/i.test(name)) pics.files.set(picRel + name, p)
    } else if (WANTED.test(name)) out.set(name, p)
    else if (spineFileKey(p)) out.set(spineFileKey(p), p)
  }
  return out
}

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

const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const videos = createVideoService()
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/__config' || url.pathname.startsWith('/__dir/') || url.pathname.startsWith('/__update/') || url.pathname.startsWith('/__pic/') || url.pathname.startsWith('/__video/')) {
    // 这些接口会读本机文件，只允许本页面自己（同源）访问
    const origin = req.headers.origin
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return void res.writeHead(403).end() }
      catch { return void res.writeHead(403).end() }
    }
  }
  if (url.pathname.startsWith('/__video/')) return void videos.handle(req, res, url)
  if (url.pathname === '/__config') {
    return sendJson(res, 200, { dir: cliDir ?? loadConfig().dir ?? '', fromCli: !!cliDir, version: APP_VERSION })
  }
  if (url.pathname === '/__update/check') {
    checkUpdate().then(
      ({ assetUrl, ...info }) => sendJson(res, 200, info),
      (e) => sendJson(res, 200, { error: e.message })
    )
    return
  }
  if (url.pathname === '/__update/ignore' && req.method === 'POST') {
    saveConfig({ ...loadConfig(), ignoredVersion: url.searchParams.get('v') ?? '' })
    return void res.writeHead(204).end()
  }
  if (url.pathname === '/__update/apply' && req.method === 'POST') {
    applyUpdate().then(
      () => {
        sendJson(res, 200, { ok: true })
        res.on('finish', () => setTimeout(restartSelf, 300))
      },
      (e) => {
        log('更新', '失败：' + e.message, C.red)
        sendJson(res, 500, { error: e.message })
      }
    )
    return
  }
  if (url.pathname === '/__dir/list') {
    const dir = resolve(url.searchParams.get('dir') ?? '')
    let names, picDir, picNames
    try {
      if (!statSync(dir).isDirectory()) throw new Error('不是文件夹')
      const pics = { found: false, files: new Map(), root: '' }
      const idx = scanDir(dir, new Map(), 0, pics)
      names = [...idx.keys()]
      picDir = pics.found
      picNames = [...pics.files.keys()]
      if (names.length || pics.found) {
        gameIndex = idx
        picIndex = pics.files
        picRoot = pics.root
        saveConfig({ ...loadConfig(), dir })
        log('目录', `${dir}（${names.length} 个相关文件${pics.found ? `，${PIC_DIR} 里 ${picNames.length} 张自定义图片` : ''}）`, C.green)
      }
    } catch (e) {
      log('目录', `无法读取 ${dir}：${e.code === 'ENOENT' ? '路径不存在' : e.message}`, C.red)
      return sendJson(res, 404, { error: `无法读取 ${dir}：${e.code === 'ENOENT' ? '路径不存在' : e.message}` })
    }
    return sendJson(res, 200, { dir, names, picDir, pics: picNames })
  }
  // 导入 / 重命名自定义图片（只允许在 SimplePatch_pic 里，文件名限制为字母数字 _ - .，且必须是 .png）
  if (url.pathname === '/__pic/upload' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? ''
    if (!picRoot || !SAFE_PIC.test(name)) return sendJson(res, 400, { error: '文件名只能包含字母、数字、_ - .，且以 .png 结尾' })
    const chunks = []
    let size = 0
    req.on('data', (d) => {
      size += d.length
      if (size <= MAX_PIC_BYTES) chunks.push(d)
    })
    req.on('end', () => {
      if (size > MAX_PIC_BYTES) return sendJson(res, 413, { error: '图片太大（上限 50MB）' })
      const data = Buffer.concat(chunks)
      if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return sendJson(res, 400, { error: '不是有效的 PNG 文件' })
      let final = name
      for (let i = 1; picIndex.has(final) || existsSync(join(picRoot, final)); i++) final = name.replace(/\.png$/i, '') + '_' + i + '.png'
      try {
        writeFileSync(join(picRoot, final), data)
      } catch (e) {
        return sendJson(res, 500, { error: '写入失败：' + e.message })
      }
      picIndex.set(final, join(picRoot, final))
      log('图片', `已导入 ${final}（${data.length} 字节）`, C.green)
      sendJson(res, 200, { name: final })
    })
    return
  }
  if (url.pathname === '/__pic/rename' && req.method === 'POST') {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const src = picIndex.get(from)
    if (!src) return sendJson(res, 404, { error: '找不到要重命名的文件' })
    if (!SAFE_PIC.test(to)) return sendJson(res, 400, { error: '文件名只能包含字母、数字、_ - .，且以 .png 结尾' })
    // 只改文件名，不换目录
    const rel = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) + to : to
    const dest = join(dirname(src), to)
    if (rel !== from && (picIndex.has(rel) || existsSync(dest))) return sendJson(res, 409, { error: '已经有同名文件了' })
    try {
      if (rel !== from) renameSync(src, dest)
    } catch (e) {
      return sendJson(res, 500, { error: '重命名失败：' + e.message })
    }
    picIndex.delete(from)
    picIndex.set(rel, dest)
    log('图片', `${from} → ${rel}`, C.green)
    return sendJson(res, 200, { name: rel })
  }
  if (url.pathname.startsWith('/__dir/pic/')) {
    const p = picIndex.get(decodeURIComponent(url.pathname.slice('/__dir/pic/'.length)))
    if (!p) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    return void createReadStream(p).pipe(res)
  }
  if (url.pathname.startsWith('/__dir/file/')) {
    const p = gameIndex.get(decodeURIComponent(url.pathname.slice('/__dir/file/'.length)))
    if (!p) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
    return void createReadStream(p).pipe(res)
  }
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
async function shutdown(reason) {
  if (exiting) return
  exiting = true
  log('退出', reason, C.cyan)
  for (const c of clients) c.end()
  server.close()
  await videos.close()
  setTimeout(() => process.exit(0), 600)
}
process.on('SIGINT', () => shutdown('收到 Ctrl+C'))
process.on('SIGTERM', () => shutdown('收到终止信号'))

function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && isRestart && tries < 20) setTimeout(() => listen(port, tries + 1), 500)
    else if (e.code === 'EADDRINUSE' && tries < 30) listen(port + 1, tries + 1)
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
    log('服务', `已启动 v${APP_VERSION}，端口 ${server.address().port}`, C.green)
    if (!noOpen && !isRestart) {
      const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      exec(`${opener} "${url}"`, (err) => {
        if (err) log('提示', `没能自动打开浏览器，请手动访问 ${url}`, C.yellow)
        else log('浏览器', '已打开，请在页面里选择游戏的 StreamingAssets 文件夹（或填写路径）')
      })
    }
    setTimeout(() => {
      if (!everConnected) shutdown('启动后一直没有页面连接')
    }, NEVER_OPENED_MS)
  })
}
listen(wantPort)
