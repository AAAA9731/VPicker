import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readBundleAssets } from '../src/unity/serialized'
import { readPxl } from '../src/pxl/reader'
const dir =
  process.env.EVIMG_DIR ?? (process.env.SA_DIR ? process.env.SA_DIR + '/EvImg' : '')
const has = existsSync(join(dir, '__ev_n.pxls.dat'))
describe.skipIf(!has)('PXL 解析', () => {
  it('解析 __ev_n', () => {
    const { texts } = readBundleAssets(new Uint8Array(readFileSync(join(dir, '__ev_n.pxls.dat'))))
    const c = readPxl('__ev_n', texts[0].bytes)
    console.log(
      'atlases',
      c.atlases.map((a) => [a.external, a.width, a.height]),
      'images',
      c.images.size,
      'poses',
      c.poses.length
    )
    console.log(
      c.poses
        .slice(0, 8)
        .map((p) => `${p.title}[${p.seqs.map((s, i) => (s ? i + ':' + s.frames.length : '')).filter(Boolean)}]`)
        .join(' | ')
    )
    expect(c.poses.length).toBeGreaterThan(0)
  })
})
