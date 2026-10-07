import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createVideoService, validateVideoSettings } from '../server/video.js'
import { exportPlan, sourceTime } from '../src/spine/timing.js'
import { spineFileKey } from '../src/game-index.js'

describe('视频时间与输入校验', () => {
  it('逐帧按速率推进动画时间，并支持起点、循环和末帧保持', () => {
    const plan = exportPlan({ width: 1280, height: 720, fps: 30, speed: 2, start: 0.75, duration: 0.11, loop: true })
    expect(plan.frames).toBe(4)
    expect(sourceTime(plan, 2, 0.8)).toBeCloseTo(0.08333333333)
    expect(sourceTime({ ...plan, loop: false }, 2, 0.8)).toBe(0.8)
    expect(sourceTime(plan, 2, 0)).toBe(0)
  })
  it('拒绝不受限的编码尺寸、时间、帧数和输出格式', () => {
    const settings = { width: 1280, height: 720, fps: 30, frames: 4, format: 'mp4' }
    for (const change of [{ width: '1280' }, { height: 100000 }, { fps: 0 }, { frames: 0 }, { frames: 3601 }, { frames: 1.5 }, { format: '../test' }]) expect(() => validateVideoSettings({ ...settings, ...change })).toThrow()
    for (const change of [{ speed: NaN }, { speed: 0 }, { start: -1 }, { duration: 121 }]) expect(() => exportPlan({ ...settings, speed: 1, start: 0, duration: 1, ...change })).toThrow()
  })
  it('不同 Spine 分类里的同名资源保持独立', () => {
    expect(spineFileKey('C:\\game\\SpineAnim\\same.atlas.dat')).toBe('SpineAnim/same.atlas.dat')
    expect(spineFileKey('game/SpineAnimEv/same.atlas.dat')).toBe('SpineAnimEv/same.atlas.dat')
    expect(spineFileKey('game/Other/same.atlas.dat')).toBeNull()
  })
})

const ffmpeg = process.env.FFMPEG_PATH || resolve('node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
describe.skipIf(!existsSync(ffmpeg))('FFmpeg 视频服务集成', () => {
  let server, service, url, root
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vpicker-video-test-'))
    service = createVideoService({ ffmpegPath: ffmpeg, tempRoot: root })
    server = http.createServer((req, res) => void service.handle(req, res, new URL(req.url, 'http://localhost')))
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    await service.close()
    await new Promise((done) => server.close(done))
    rmSync(root, { force: true, recursive: true })
  })
  const post = (path, value = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  it.each(['mp4', 'webm'])('实际编码 %s，固定四帧，方向及颜色正确', async (format) => {
    const created = await post('/__video/create', { width: 1280, height: 720, fps: 30, frames: 4, format })
    expect(created.status, created.status === 201 ? '' : await created.text()).toBe(201)
    const { id } = await created.json()
    const pixels = Buffer.alloc(1280 * 720 * 4)
    for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) {
      const offset = (y * 1280 + x) * 4
      pixels[offset + (y < 360 ? 2 : 0)] = 255
      pixels[offset + 3] = 255
    }
    expect((await post(`/__video/${id}/finish`)).status).toBe(400)
    for (let i = 0; i < 4; i++) {
      const frame = await fetch(`${url}/__video/${id}/frame?index=${i}`, { method: 'POST', body: pixels })
      expect(frame.status, frame.status === 200 ? '' : await frame.text()).toBe(200)
    }
    const completed = await post(`/__video/${id}/finish`)
    expect(completed.status, completed.status === 200 ? '' : await completed.text()).toBe(200)
    const result = await completed.json()
    expect(result.frames).toBe(4)
    expect(result.duration).toBeCloseTo(4 / 30)
    const downloaded = await fetch(url + result.url)
    expect(downloaded.headers.get('content-type')).toBe(`video/${format}`)
    const output = join(root, `test.${format}`)
    writeFileSync(output, Buffer.from(await downloaded.arrayBuffer()))
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=1:2:flags=neighbor', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
    expect(decoded.status).toBe(0)
    expect(decoded.stdout.length).toBe(4 * 2 * 3)
    for (let i = 0; i < 4; i++) {
      const rgb = decoded.stdout.subarray(i * 6, i * 6 + 6)
      expect(rgb[0]).toBeGreaterThan(200); expect(rgb[2]).toBeLessThan(30)
      expect(rgb[3]).toBeLessThan(30); expect(rgb[5]).toBeGreaterThan(200)
    }
    expect((await post(`/__video/${id}/cancel`)).status).toBe(200)
    expect((await fetch(url + result.url)).status).toBe(404)
  }, 30000)
  it('拒绝乱序帧，不完整帧会终止任务，取消后能开始新任务', async () => {
    const make = async () => (await (await post('/__video/create', { width: 1280, height: 720, fps: 30, frames: 1, format: 'mp4' })).json()).id
    const id = await make()
    expect((await post('/__video/create', { width: 1280, height: 720, fps: 30, frames: 1, format: 'mp4' })).status).toBe(400)
    expect((await fetch(`${url}/__video/${id}/frame?index=1`, { method: 'POST', body: Buffer.alloc(4) })).status).toBe(400)
    expect((await fetch(`${url}/__video/${id}/frame?index=0`, { method: 'POST', body: Buffer.alloc(4) })).status).toBe(400)
    expect((await post(`/__video/${id}/finish`)).status).toBe(404)
    const second = await make()
    expect(second).toBeTruthy()
    expect((await post(`/__video/${second}/cancel`)).status).toBe(200)
  })
})
