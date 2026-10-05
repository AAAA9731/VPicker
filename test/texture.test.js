import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readBundleAssets } from '../src/unity/serialized'
import { decodeTexture } from '../src/unity/texture'
const dir =
  process.env.EVIMG_DIR ?? (process.env.SA_DIR ? process.env.SA_DIR + '/EvImg' : '')
const has = existsSync(join(dir, '__ev_n.pxls.dat'))
describe.skipIf(!has)('贴图解码', () => {
  it('解码 __ev_n 的 Crunch 图集', async () => {
    const { textures } = readBundleAssets(new Uint8Array(readFileSync(join(dir, '__ev_n.pxls.bytes.texture_0.dat'))))
    const img = await decodeTexture(textures[0])
    expect([img.width, img.height]).toEqual([4096, 8192])
    let opaque = 0
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++
    console.log('不透明像素占比', (opaque / (img.width * img.height)).toFixed(3))
    expect(opaque).toBeGreaterThan(1000)
    if (process.env.DUMP_DIR) {
      mkdirSync(process.env.DUMP_DIR, { recursive: true })
      writeFileSync(join(process.env.DUMP_DIR, 'ev_n.rgba'), img.data)
    }
  }, 120000)
})
