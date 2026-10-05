import { getEmotInfo } from './pxl/person'

/**
 * 批处理：把“一个固定项 × 另一维的全部取值”展开成 [{ pose, emotion }] 列表。
 * - byEmotion：某个表情 → 所有带有这个表情的姿势（游戏里表情差分按姿势分组，不是每个姿势都有）
 * - byPose：某个姿势 → 它的所有表情
 */
export function collectByEmotion(person, emotion) {
  const out = []
  for (const pose of person.poses) {
    if (pose.dontAppearOnEditor) continue
    if (getEmotInfo(pose, emotion)) out.push({ pose, emotion })
  }
  return out
}

export function collectByPose(pose) {
  return (pose.emotions ?? []).map((e) => ({ pose, emotion: e.key }))
}

const RegFrame = /^(.*\/a)(\d+)$/

/**
 * 非立绘图片：取包含当前姿势的“连续序号序列”（如 walk/a0、walk/a1、walk/a2…，通常是帧动画）。
 * 序号必须连续；当前图不是 `名字/aN` 形式时只返回它自己。
 */
export function collectFrameRun(person, pose) {
  const m = RegFrame.exec(pose.name)
  if (!m) return [{ pose, emotion: null }]
  const byIdx = new Map()
  for (const p of person.poses) {
    const q = RegFrame.exec(p.name)
    if (q && q[1] === m[1] && !byIdx.has(+q[2])) byIdx.set(+q[2], p)
  }
  const i = +m[2]
  let lo = i
  let hi = i
  while (byIdx.has(lo - 1)) lo--
  while (byIdx.has(hi + 1)) hi++
  const out = []
  for (let k = lo; k <= hi; k++) out.push({ pose: byIdx.get(k), emotion: null })
  return out
}

/** 非立绘图片：整个图片包里的全部图。 */
export function collectAllPoses(person) {
  return person.poses.map((pose) => ({ pose, emotion: null }))
}

// ───────────── 最小 ZIP 写入（仅存储，不压缩；PNG 本身已压缩） ─────────────
let crcTable = null
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** files: [{ name: string, data: Uint8Array }]；文件名按 UTF-8 写入，兼容中文。 */
export function makeZip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // UTF-8 文件名
    local.setUint16(8, 0, true) // 存储
    local.setUint32(14, crc, true)
    local.setUint32(18, f.data.length, true)
    local.setUint32(22, f.data.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, f.data)

    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, f.data.length, true)
    c.setUint32(24, f.data.length, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    central.push(new Uint8Array(c.buffer), name)
    offset += 30 + name.length + f.data.length
  }
  let centralSize = 0
  for (const p of central) centralSize += p.length
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}

/** 把姿势名/表情名里不能用于文件名的字符替换掉。 */
export function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_')
}
