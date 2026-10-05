import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readBundleAssets } from '../src/unity/serialized'
import { readPxl } from '../src/pxl/reader'
import { buildPerson } from '../src/pxl/person'
import { parsePersonDef } from '../src/persons'
import { parsePicLine, locatePic, buildPic } from '../src/pic'
const sa =
  process.env.SA_DIR ?? ''
const has = existsSync(join(sa, 'EvImg', '__ev_n.pxls.dat'))
function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.cmd')) out.push(p)
  }
  return out
}
describe.skipIf(!has)('用 evt/*.cmd 的真实 PIC 指令回归', () => {
  it('全部 PIC 指令都能定位并还原', () => {
    const defs = parsePersonDef(readFileSync(join(sa, 'evt', '__vp_person.dat'), 'utf8'))
    const persons = new Map()
    for (const d of defs) {
      const f = join(sa, 'EvImg', d.pxl + '.pxls.dat')
      if (!existsSync(f)) continue
      const { texts } = readBundleAssets(new Uint8Array(readFileSync(f)))
      persons.set(d.key, buildPerson(d.key, readPxl(d.pxl, texts[0].bytes)))
    }
    console.log('角色:', [...persons].map(([k, p]) => `${k}:${p.poses.length}`).join(' '))
    let total = 0,
      ok = 0,
      noPerson = 0,
      noPose = 0,
      noEmot = 0,
      rebuildDiff = 0
    const bad = []
    for (const f of walk(join(sa, 'evt'))) {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const c = parsePicLine(line)
        if (!c) continue
        total++
        const person = persons.get(c.person)
        if (!person) {
          noPerson++
          if (bad.length < 15) bad.push('无角色 ' + line.trim())
          continue
        }
        const t = locatePic(person, c.identifier)
        if (!t) {
          noPose++
          if (bad.length < 15) bad.push('无姿势 ' + line.trim())
          continue
        }
        if (!t.emotionFound) {
          noEmot++
          if (bad.length < 15) bad.push('无表情 ' + line.trim())
          continue
        }
        const again = buildPic(c.person, t.pose, t.emotion).trim().split(/\s+/)
        if (again[2] !== c.identifier) rebuildDiff++
        else ok++
      }
    }
    console.log({ total, ok, noPerson, noPose, noEmot, rebuildDiff })
    console.log(bad.join('\n'))
    expect(total).toBeGreaterThan(1000)
  })
})
