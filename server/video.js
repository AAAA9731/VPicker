import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAsset, isSea } from 'node:sea'
import { gunzipSync } from 'node:zlib'

const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
export function validateVideoSettings(input) {
  const { width, height, fps, frames, format } = input ?? {}
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !['1280x720', '1920x1080', '2560x1440'].includes(`${width}x${height}`) || ![24, 30, 60].includes(fps)) throw Error('分辨率或帧率无效')
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > fps * 120) throw Error('视频时长须在 0 至 120 秒内')
  if (!['mp4', 'webm'].includes(format)) throw Error('只支持 MP4 / WebM 视频')
  return { width, height, fps, frames, format }
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Error('需要 JSON 请求')
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4096) throw Error('请求过大')
  }
  return JSON.parse(body)
}
/** Own process, raw RGBA input, fixed frame count. Nothing executes through a shell. */
export function createVideoService({ ffmpegPath, tempRoot = tmpdir() } = {}) {
  const jobs = new Map()
  let toolDir, executable, capabilities, disposed = false
  function tool() {
    if (executable) return executable
    if (ffmpegPath) executable = ffmpegPath
    else if (isSea()) {
      toolDir = mkdtempSync(join(tempRoot, 'vpicker-ffmpeg-'))
      executable = join(toolDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      writeFileSync(executable, gunzipSync(Buffer.from(getAsset('tools/ffmpeg.gz'))), { mode: 0o700 })
    } else {
      const npmFFmpeg = resolve('node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      executable = process.env.FFMPEG_PATH || (existsSync(npmFFmpeg) ? npmFFmpeg : 'ffmpeg')
    }
    return executable
  }
  function available() {
    if (capabilities) return capabilities
    const result = spawnSync(tool(), ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw Error('FFmpeg 不可用；开发运行时请设置 FFMPEG_PATH，发行版已内置')
    const formats = []
    if (/\blibx264\b/.test(result.stdout)) formats.push('mp4')
    if (/\blibvpx-vp9\b/.test(result.stdout)) formats.push('webm')
    if (!formats.length) throw Error('FFmpeg 缺少 H.264 / VP9 编码器')
    capabilities = { available: true, formats, maxDuration: 120 }
    return capabilities
  }
  function remove(job) {
    jobs.delete(job.id)
    if (job.process.exitCode === null && !job.closed) {
      job.process.once('close', () => rmSync(job.dir, { force: true, recursive: true }))
      job.process.kill()
    } else rmSync(job.dir, { force: true, recursive: true })
  }
  function check(job) {
    if (job.error) throw Error(job.error)
    if (job.closed && !job.finished) throw Error('FFmpeg 意外结束：' + job.stderr.slice(-1200))
  }
  async function create(input) {
    if (disposed) throw Error('服务正在退出')
    const settings = validateVideoSettings(input)
    if (!available().formats.includes(settings.format)) throw Error('这个 FFmpeg 不支持所选视频格式')
    if ([...jobs.values()].some((job) => !job.finished)) throw Error('已有视频正在导出，请先完成或取消')
    const dir = mkdtempSync(join(tempRoot, 'vpicker-video-'))
    const output = join(dir, `video.${settings.format}`)
    const codec = settings.format === 'mp4'
      ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
      : ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p']
    const child = spawn(tool(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${settings.width}x${settings.height}`, '-framerate', String(settings.fps), '-i', 'pipe:0', '-an', '-vf', 'vflip', '-frames:v', String(settings.frames), ...codec, output], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    const job = { id: randomUUID(), dir, output, process: child, settings, received: 0, busy: false, finishing: false, finished: false, closed: false, stderr: '', error: '', touched: Date.now() }
    child.stderr.on('data', (data) => { job.stderr = (job.stderr + data).slice(-4000) })
    child.stdin.on('error', (error) => { job.error = error.message })
    job.done = new Promise((resolve) => {
      child.once('error', (error) => { job.error = error.message })
      child.once('close', (code) => { job.closed = true; resolve(code) })
    })
    jobs.set(job.id, job)
    return job
  }
  async function frame(job, req, index) {
    check(job)
    if (job.busy || job.finishing || index !== job.received || index >= job.settings.frames) throw Error('帧顺序或任务状态无效')
    job.busy = true
    job.touched = Date.now()
    let bytes = 0
    const expected = job.settings.width * job.settings.height * 4
    try {
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > expected) throw Error('帧数据过大')
        check(job)
        await new Promise((resolve, reject) => job.process.stdin.write(chunk, (error) => error ? reject(error) : resolve()))
      }
      if (bytes !== expected) throw Error('帧数据不完整')
      check(job)
      job.received++
      job.touched = Date.now()
    } catch (error) {
      remove(job)
      throw error
    } finally { job.busy = false }
  }
  async function finish(job) {
    check(job)
    if (job.busy || job.finishing || job.received !== job.settings.frames) throw Error('尚未收到全部视频帧')
    job.finishing = true
    job.touched = Date.now()
    job.process.stdin.end()
    const timeout = setTimeout(() => { job.error = '视频编码超时'; job.process.kill() }, 120000)
    const code = await job.done
    clearTimeout(timeout)
    if (code !== 0 || job.error || !existsSync(job.output) || statSync(job.output).size === 0) {
      remove(job)
      throw Error(job.error || '编码失败：' + job.stderr)
    }
    job.finished = true
    job.touched = Date.now()
    return { url: `/__video/${job.id}/download`, frames: job.received, duration: job.received / job.settings.fps }
  }
  async function handle(req, res, url) {
    let job
    try {
      if (url.pathname === '/__video/capabilities' && req.method === 'GET') return json(res, 200, available())
      if (url.pathname === '/__video/create' && req.method === 'POST') {
        job = await create(await readJson(req))
        return json(res, 201, { id: job.id, frames: job.settings.frames })
      }
      const match = /^\/__video\/([0-9a-f-]{36})\/(frame|finish|download|cancel)$/.exec(url.pathname)
      job = match && jobs.get(match[1])
      if (!job) return json(res, 404, { error: '视频任务不存在或已过期' })
      if (match[2] === 'frame' && req.method === 'POST') {
        await frame(job, req, Number(url.searchParams.get('index')))
        return json(res, 200, { received: job.received })
      }
      if (match[2] === 'finish' && req.method === 'POST') return json(res, 200, await finish(job))
      if (match[2] === 'cancel' && req.method === 'POST') { remove(job); return json(res, 200, { cancelled: true }) }
      if (match[2] === 'download' && req.method === 'GET' && job.finished) {
        job.touched = Date.now()
        res.writeHead(200, { 'content-type': job.settings.format === 'mp4' ? 'video/mp4' : 'video/webm', 'content-length': statSync(job.output).size, 'content-disposition': `attachment; filename="animation.${job.settings.format}"`, 'cache-control': 'no-store' })
        const stream = createReadStream(job.output)
        stream.on('error', () => res.destroy())
        res.once('close', () => stream.destroy())
        return void stream.pipe(res)
      }
      json(res, 405, { error: '操作不允许' })
    } catch (error) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: error.message }) }
  }
  const sweep = setInterval(() => {
    for (const job of jobs.values()) if (Date.now() - job.touched > (job.finished ? 600000 : 180000)) remove(job)
  }, 60000)
  sweep.unref()
  return {
    handle,
    async close() {
      disposed = true
      clearInterval(sweep)
      const pending = [...jobs.values()]
      for (const job of pending) remove(job)
      await Promise.all(pending.map((job) => job.done))
      if (toolDir) rmSync(toolDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}
