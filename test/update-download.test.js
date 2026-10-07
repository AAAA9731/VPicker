import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadUpdate } from '../server/update-download.js'

describe('更新文件下载', () => {
  const bytes = Buffer.alloc(12288, 7)
  let server, url, root
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vpicker-update-test-'))
    server = http.createServer((req, res) => {
      if (req.url === '/error') return void res.writeHead(503).end()
      if (req.url === '/interrupted') {
        res.writeHead(200, { 'content-length': bytes.length })
        res.write(bytes.subarray(0, 4096))
        setTimeout(() => res.destroy(), 30)
        return
      }
      res.writeHead(200, req.url === '/known' ? { 'content-length': bytes.length } : {})
      res.write(bytes.subarray(0, 4096))
      setTimeout(() => res.write(bytes.subarray(4096, 8192)), 150)
      setTimeout(() => res.end(bytes.subarray(8192)), 300)
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    await new Promise((done) => server.close(done))
    rmSync(root, { recursive: true, force: true })
  })
  it.each([
    ['known', 0, 12288],
    ['fallback', 12288, 12288],
    ['unknown', 0, 0],
  ])('%s：边下载边报告实际字节，缺少文件大小时也可下载', async (path, size, total) => {
    const output = join(root, path)
    const progress = []
    const count = await downloadUpdate(`${url}/${path}`, output, { size, onProgress: (value) => progress.push(value) })
    expect(count).toBe(bytes.length)
    expect(readFileSync(output)).toEqual(bytes)
    expect(progress[0]).toEqual({ downloaded: 0, total })
    expect(progress.some((value) => value.downloaded > 0 && value.downloaded < bytes.length)).toBe(true)
    expect(progress.at(-1)).toEqual({ downloaded: bytes.length, total })
    expect(progress.every((value, index) => !index || value.downloaded >= progress[index - 1].downloaded)).toBe(true)
  })
  it.each(['interrupted', 'error'])('%s：下载失败清理临时文件，重试可以成功', async (path) => {
    const output = join(root, path)
    await expect(downloadUpdate(`${url}/${path}`, output)).rejects.toThrow()
    expect(existsSync(output)).toBe(false)
    await downloadUpdate(`${url}/known`, output)
    expect(readFileSync(output)).toEqual(bytes)
  })
  it('实际字节与发布文件大小不一致时拒绝安装', async () => {
    const output = join(root, 'mismatch')
    await expect(downloadUpdate(`${url}/unknown`, output, { size: bytes.length + 1 })).rejects.toThrow('下载的文件不完整')
    expect(existsSync(output)).toBe(false)
  })
})
