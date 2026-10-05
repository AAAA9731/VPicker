import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readBundleAssets } from '../src/unity/serialized'
const dir =
  process.env.EVIMG_DIR ?? (process.env.SA_DIR ? process.env.SA_DIR + '/EvImg' : '')
const has = existsSync(join(dir, '__ev_n.pxls.dat'))
describe.skipIf(!has)('UnityFS 解包', () => {
  it('读取 __ev_n.pxls.dat 的 PXL TextAsset', () => {
    const { texts } = readBundleAssets(new Uint8Array(readFileSync(join(dir, '__ev_n.pxls.dat'))))
    expect(texts).toHaveLength(1)
    expect(texts[0].name).toBe('__ev_n.pxls')
    expect(texts[0].bytes.length).toBe(38131)
    expect(Array.from(texts[0].bytes.subarray(4, 8))).toEqual([0x50, 0x58, 0x4c, 0x53]) // "PXLS"
  })
  it('读取贴图包的 Texture2D', () => {
    const { textures } = readBundleAssets(new Uint8Array(readFileSync(join(dir, '__ev_n.pxls.bytes.texture_0.dat'))))
    expect(textures).toHaveLength(1)
    const t = textures[0]
    expect([t.width, t.height, t.format]).toEqual([4096, 8192, 29])
    expect(t.data.length).toBe(2504403)
  })
})
