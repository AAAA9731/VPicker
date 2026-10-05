import { Reader } from '../unity/bytes'
const HEADER1 = 2000791807
const SCT_LEN = 14
const td = new TextDecoder('utf-8')
function readStr(r) {
  const n = r.u16()
  if (n === 0) return ''
  return td.decode(r.bytes(n))
}
/** readExtractBytes：4 字节长度前缀的子块 */
function extract(r) {
  const n = r.u32()
  return new Reader(r.bytes(n), false)
}
const imgKey = (id, id2) => id + ':' + id2
export function readPxl(title, data) {
  const r = new Reader(data, false)
  if (r.u32() !== HEADER1 || td.decode(r.bytes(4)) !== 'PXLS') throw new Error('PXL 文件头无效')
  const chara = { title, atlases: [], images: new Map(), poses: [], imageOwners: new Map() }
  let sawImage = false
  while (r.length - r.pos > SCT_LEN) {
    const tag = td.decode(r.bytes(SCT_LEN))
    if (tag === '%PACK_SECTION%') {
      const b = extract(r)
      const count = b.u32()
      for (let i = 0; i < count; i++) readAtlas(b, chara)
      sawImage = true
    } else if (tag === '%POSE_SECTION%') {
      if (!sawImage) throw new Error('POSE 段必须在图像段之后')
      const b = extract(r)
      const count = b.u32()
      for (let i = 0; i < count; i++) {
        const p = readPose(b, chara, chara.poses.length)
        if (p) chara.poses.push(p)
      }
    } else if (tag === '%PTCL_SECTION%') {
      extract(r) // 颜色数据，立绘选择器用不到
    } else if (tag === '%IMGV_SECTION%') {
      extract(r) // 图像的顶点/网格附加数据，图集本身已在 PACK 段里，选择器只需要位图
    } else if (tag === '%IMGS_SECTION%' || tag === '%IMGD_SECTION%') {
      throw new Error('不支持的图像段类型: ' + tag)
    } else {
      throw new Error('无效的段标签: ' + tag)
    }
  }
  return chara
}
function readAtlas(b, chara) {
  const index = chara.atlases.length
  const type = b.u8() - 22
  if (type < 0) {
    chara.atlases.push({ index, external: false, width: 0, height: 0, margin: 0 })
    return
  }
  const flags = b.u8()
  const margin = b.u8()
  const n = b.u32()
  const entries = []
  for (let i = 0; i < n; i++) {
    const id = b.u32()
    const id2 = b.f64()
    entries.push({ key: imgKey(id, id2), x: b.u32(), y: b.u32(), w: b.u32(), h: b.u32() })
  }
  const atlas = { index, external: (flags & 1) === 1, width: 0, height: 0, margin }
  if (atlas.external) {
    atlas.width = b.u32()
    atlas.height = b.u32()
  } else {
    const len = b.u32()
    atlas.png = b.bytes(len).slice()
  }
  chara.atlases.push(atlas)
  for (const e of entries) {
    // 精灵矩形（图集左上原点）：x+margin, y+margin
    chara.images.set(e.key, { key: e.key, w: e.w - margin * 2, h: e.h - margin * 2, atlas: index, x: e.x + margin, y: e.y + margin })
  }
}
function readPose(b, chara, index) {
  const h = extract(b)
  const ver = h.u8()
  h.bool()
  h.bool() // auto_flip, tetra_pose
  const title = readStr(h)
  const width = h.u16()
  const height = h.u16()
  h.u16()
  readStr(h) // end_jump_loop_count, end_jump_title
  const aliasN = h.u16()
  for (let i = 0; i < aliasN; i++) readStr(h)
  const comment = ver >= 2 ? readStr(h) : ''
  const pose = { index, title, width, height, comment, seqs: new Array(8).fill(null), chara }
  let any = false
  for (;;) {
    const t = b.u8()
    if (t === 0) break
    const aim = t - 10
    const seq = readSequence(b, pose, aim)
    if (seq && aim >= 0 && aim < 8) {
      pose.seqs[aim] = seq
      any = true
    }
  }
  return any ? pose : null
}
function readSequence(b, pose, aim) {
  const h = extract(b)
  h.u8()
  const width = h.u16()
  const height = h.u16()
  const seq = { aim, width, height, frames: [], pose }
  const n = b.u16()
  for (let i = 0; i < n; i++) {
    const f = readFrame(b, seq)
    if (f) {
      f.index = seq.frames.length
      seq.frames.push(f)
    }
  }
  return seq.frames.length > 0 ? seq : null
}
function readFrame(b, seq) {
  const h = extract(b)
  const vers = h.u8()
  h.i16()
  const name = readStr(h)
  const frame = { name, layers: [], index: 0, seq }
  const n = b.i16()
  for (let i = 0; i < n; i++) {
    const l = readLayer(b, frame, vers)
    if (l) frame.layers.push(l)
  }
  return frame.layers.length > 0 ? frame : null
}
function readLayer(b, frame, _vers) {
  const chara = frame.seq.pose.chara
  const id = b.u32()
  const id2 = b.f64()
  const type = b.u8()
  const key = imgKey(id, id2)
  const img = chara.images.get(key) ?? null
  const name = readStr(b)
  let alpha = Math.trunc(b.i16() / 100)
  alpha = Math.max(0, Math.min(100, alpha))
  const isGroup = (type & 8) > 0
  const layer = {
    name,
    type,
    alpha,
    x: 0,
    y: 0,
    zmx: 1,
    zmy: 1,
    rotR: 0,
    blend: 0,
    imgKey: img ? key : null,
    isImport: (type & 1) > 0,
    isGroup,
    frame,
  }
  if (isGroup) {
    b.u32()
    return layer
  }
  layer.x = b.i16() / 10
  layer.y = b.i16() / 10
  layer.zmx = b.f64()
  layer.zmy = b.f64()
  layer.rotR = b.f64()
  if (img && layer.rotR === 0) {
    if (img.w % 2 === 1) layer.x += 0.5
    if (img.h % 2 === 1) layer.y += 0.5
  }
  layer.blend = b.u16()
  b.u32()
  b.u8()
  b.u8()
  if (!img) return null
  if (!layer.isImport) {
    let list = chara.imageOwners.get(key)
    if (!list) chara.imageOwners.set(key, (list = []))
    list.push(layer)
  }
  return layer
}
/** PxlLayer.getImportSource：import 图层溯源到真正持有图像的图层。 */
export function importSource(chara, l) {
  if (!l.isImport) return l
  const list = l.imgKey ? chara.imageOwners.get(l.imgKey) : undefined
  if (!list) return null
  for (const o of list) if (o !== l) return o
  return null
}
