import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readBundleAssets } from '../src/unity/serialized'
import { readPxl } from '../src/pxl/reader'
import { buildPerson } from '../src/pxl/person'
import { collectByEmotion, collectByPose, makeZip, safeFileName } from '../src/batch'
import { buildPic, locatePic } from '../src/pic'

const sa =
  process.env.SA_DIR ?? ''
const has = existsSync(join(sa, 'EvImg', '__ev_n.pxls.dat'))

describe('ZIP 写入', () => {
  it('生成合法的 zip 结构', async () => {
    const files = [
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: '中文/b.bin', data: new Uint8Array([1, 2, 3, 4]) },
    ]
    const blob = makeZip(files)
    const buf = new Uint8Array(await blob.arrayBuffer())
    const dv = new DataView(buf.buffer)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    const end = buf.length - 22
    expect(dv.getUint32(end, true)).toBe(0x06054b50)
    expect(dv.getUint16(end + 10, true)).toBe(2)
    if (process.env.DUMP_DIR) {
      mkdirSync(process.env.DUMP_DIR, { recursive: true })
      writeFileSync(join(process.env.DUMP_DIR, 'test.zip'), buf)
    }
  })
  it('safeFileName', () => {
    expect(safeFileName('a_3/a2 x:y')).toBe('a_3_a2_x_y')
  })
})

describe.skipIf(!has)('批处理展开', () => {
  const dir = join(sa, 'EvImg')
  const { texts } = has ? readBundleAssets(new Uint8Array(readFileSync(join(dir, '__ev_n.pxls.dat')))) : { texts: [] }
  const person = has ? buildPerson('n', readPxl('__ev_n', texts[0].bytes)) : null

  it('某个姿势的所有表情', () => {
    const pose = person.poses.find((p) => p.name === 'a_3/a2')
    const items = collectByPose(pose)
    expect(items.length).toBeGreaterThan(5)
    for (const it of items) expect(locatePic(person, buildPic('n', it.pose, it.emotion).trim().split(/\s+/)[2]).emotionFound).toBe(true)
  })

  it('某个表情的所有姿势', () => {
    const pose = person.poses.find((p) => p.name === 'a_3/a2')
    const emo = pose.emotions[0].key
    const items = collectByEmotion(person, emo)
    expect(items.length).toBeGreaterThan(1)
    expect(items.some((i) => i.pose === pose)).toBe(true)
    console.log(`表情 ${emo} 出现在 ${items.length} 个姿势`)
  })
})

describe('collectFrameRun', () => {
  const mk = (...names) => ({ poses: names.map((name) => ({ name })) })
  it('只取包含当前图的连续序号序列', async () => {
    const { collectFrameRun } = await import('../src/batch')
    const person = mk('walk/a0', 'walk/a1', 'walk/a2', 'walk/a4', 'stand/a0', 'icon')
    const names = (p) => collectFrameRun(person, p).map((x) => x.pose.name)
    expect(names(person.poses[1])).toEqual(['walk/a0', 'walk/a1', 'walk/a2'])
    expect(names(person.poses[3])).toEqual(['walk/a4'])
    expect(names(person.poses[5])).toEqual(['icon'])
  })
})
