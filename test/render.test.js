import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { GameFiles, loadPerson } from '../src/loader'
import { canvasFactory, drawPose, drawFaceThumb } from '../src/render'
import { locatePic } from '../src/pic'
const sa =
  process.env.SA_DIR ?? ''
const has = existsSync(join(sa, 'EvImg', '__ev_n.pxls.dat'))
describe.skipIf(!has && !process.env.DUMP_DIR)('渲染', () => {
  it('把 PIC 指令渲染成 PNG', async () => {
    canvasFactory.create = (w, h) => createCanvas(w, h)
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const gf = new GameFiles()
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/^(__ev_.*\.dat|__vp_person\.dat)$/.test(f)) gf.files.set(f, async () => new File([readFileSync(p)], f))
      }
    }
    walk(join(sa, 'EvImg'))
    walk(join(sa, 'evt'))
    await gf.finish()
    const def = gf.defs.find((d) => d.key === 'n')
    const lp = await loadPerson(gf, def)
    const lines = ['a_3/a2__F1__f3__m1__b1_uo', 'a_1/a00L1R1__F1__f1__m1__b3__u0']
    const out = process.env.DUMP_DIR
    if (out) mkdirSync(out, { recursive: true })
    let k = 0
    for (const id of lines) {
      const t = locatePic(lp.person, id)
      console.log(id, '→', t ? `${t.pose.name} emotionFound=${t.emotionFound}` : '未找到')
      if (!t) continue
      const pose = t.pose.source.seq.pose
      const s = Math.min(1, 1000 / pose.height)
      const c = createCanvas(Math.round(pose.width * s), Math.round(pose.height * s))
      const ctx = c.getContext('2d')
      drawPose(ctx, lp.store, t.pose, t.emotion, c.width / 2, c.height / 2, s)
      if (out) writeFileSync(join(out, `pose${k++}.png`), c.toBuffer('image/png'))
    }
    // 表情缩略图
    const p0 = lp.person.poses.find((p) => p.emotions && p.emotions.length > 4)
    const ft = createCanvas(96 * 6, 72 * 2)
    const fctx = ft.getContext('2d')
    p0.emotions.slice(0, 12).forEach((e, i) => {
      fctx.save()
      fctx.translate((i % 6) * 96, Math.floor(i / 6) * 72)
      drawFaceThumb(fctx, lp.store, e.frame, 96, 72)
      fctx.restore()
    })
    if (out) writeFileSync(join(out, 'faces.png'), ft.toBuffer('image/png'))
    expect(lp.person.poses.length).toBeGreaterThan(0)
  }, 180000)
})

describe.skipIf(!has)('非立绘图片包', () => {
  it('能区分并加载 __events_* 等图片包', async () => {
    const gf = new GameFiles()
    const dir = join(sa, 'EvImg')
    for (const f of readdirSync(dir)) gf.files.set(f, async () => new File([readFileSync(join(dir, f))], f))
    await gf.finish()
    expect(gf.others.length).toBeGreaterThan(10)
    expect(gf.others.some((d) => d.key === '__events_forest')).toBe(true)
    expect(gf.others.some((d) => d.pxl.startsWith('__ev_'))).toBe(false)
    const lp = await loadPerson(gf, gf.others.find((d) => d.key === '__events_forest'))
    expect(lp.person.poses.length).toBeGreaterThan(0)
  })
})
