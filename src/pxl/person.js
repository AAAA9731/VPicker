import { importSource } from './reader'
const RegFacePat = /^(m[a-zA-Z0-9]*_)?f(\d+)/i
const RegLa = /^la(\d+)/i
const RegRa = /^ra(\d+)/i
const RegNameForEmot = /^m[_\d]/
const RegLayerSplitter = /\blayer_splitter[ \s\t]+([^\n \s\t\r/]+)/
export const RegFacePrefix = /^F(\d+)__/
const DONT_APPEAR = '__DONT_APPEAR_EDITOR__'
const bit = (i) => (1 << (i & 31)) >>> 0
/** 对应 EvPerson.initPxEmot(PxlCharacter) */
export function buildPerson(key, chara) {
  const out = []
  for (let pi = chara.poses.length - 1; pi >= 0; pi--) {
    const pose = chara.poses[pi]
    if (pose.title.indexOf('_') === 0) continue
    const count = out.length
    for (let aim = 0; aim < 8; aim++) {
      const sq = pose.seqs[aim]
      if (sq) initSequence(out, sq)
    }
    const count2 = out.length
    for (let j = count + 1; j < count2; j++) out[j].faceY = out[count].faceY
    if (pose.comment.trim()) applyPoseComment(out, count, count2, pose.comment)
  }
  return { key, chara, poses: out }
}
function applyPoseComment(out, from, to, comment) {
  for (const raw of comment.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    const t = line.split(/[ \t]+/)
    const n = parseFloat(t[1] ?? '')
    const v = Number.isNaN(n) ? 0 : n
    switch (t[0]) {
      case 'scale':
        for (let i = from; i < to; i++) out[i].drawScale = v / 100
        break
      case 'shift_y':
        for (let i = from; i < to; i++) out[i].shiftY += v
        break
      case 'shift_y_set':
        for (let i = from; i < to; i++) out[i].shiftY = v
        break
      default:
        break
    }
  }
}
function initSequence(out, sq) {
  for (let i = 0; i < sq.frames.length; i++) initFrame(out, i, sq.frames[i])
}
function initFrame(out, frmIndex, F) {
  const chara = F.seq.pose.chara
  const laBuf = new Map()
  const raBuf = new Map()
  let emoBits = 0
  let visBits = 0
  let faceBits = null
  const emotPoses = []
  const prefixNums = []
  let listup = ''
  let dontAppear = false
  const n = F.layers.length
  for (let i = 0; i < n; i++) {
    const layer = F.layers[i]
    let text2 = layer.name
    let flag = layer.alpha > 0
    let num6 = -1
    if (text2.endsWith(DONT_APPEAR)) dontAppear = true
    let m = RegFacePat.exec(text2)
    if (m) {
      text2 = (m[1] ?? '') + text2.slice(m[0].length)
      num6 = parseInt(m[2], 10)
      if (!faceBits) faceBits = new Map()
      faceBits.set(num6, ((faceBits.get(num6) ?? 0) | bit(i)) >>> 0)
      flag = false
    }
    if (text2.indexOf('m') === 0 && (text2 === 'm' || RegNameForEmot.test(text2)) && layer.isImport) {
      const src = importSource(chara, layer)
      if (!src || src === layer) continue
      const sp = src.frame.seq.pose
      if (emotPoses.some((e) => e.pose === sp)) continue
      emotPoses.push({ pose: sp, shiftx: -src.x, shifty: src.y })
      listup = listup ? listup + ',' + sp.title : sp.title
      prefixNums.push(num6)
      emoBits = (emoBits | bit(i)) >>> 0
      flag = num6 === -1
    } else if ((m = RegLa.exec(text2))) {
      const k = m[1]
      if (!laBuf.has(k)) laBuf.set(k, [])
      laBuf.get(k).push(i)
      flag = false
    } else if ((m = RegRa.exec(text2))) {
      const k = m[1]
      if (!raBuf.has(k)) raBuf.set(k, [])
      raBuf.get(k).push(i)
      flag = false
    }
    if (flag) visBits = (visBits | bit(i)) >>> 0
  }
  const text3 = F.seq.pose.title + '/' + (F.name.indexOf('a') === 0 ? F.name : 'a' + frmIndex)
  let emotions = null
  if (listup !== '') {
    listup = chara.title + '#' + listup
    emotions = []
    for (let j = 0; j < emotPoses.length; j++) {
      const num9 = prefixNums[j]
      collectEmotions(emotions, emotPoses[j].pose, num9 === -1 ? '' : 'F' + num9 + '__')
    }
  }
  const poseArr = emotPoses.length ? emotPoses : null
  const mk = (name, vis) => {
    const ep = {
      name,
      source: F,
      visBits: vis,
      emoBits,
      faceBits,
      emotions,
      emotPoses: poseArr,
      dontAppearOnEditor: dontAppear,
      drawScale: 1,
      shiftY: 120,
      faceY: 0,
      listup,
    }
    if (emotions) {
      for (let i = 0; i < n; i++) {
        if ((emoBits & bit(i)) !== 0) {
          ep.faceY = -F.layers[i].y
          break
        }
      }
    }
    out.push(ep)
  }
  if (laBuf.size > 0 || raBuf.size > 0) {
    const la = [...laBuf.keys()]
    const ra = [...raBuf.keys()]
    for (let k = la.length === 0 ? -1 : 0; k < la.length; k++) {
      let b1 = visBits
      if (k >= 0) for (const li of laBuf.get(la[k])) b1 = (b1 | bit(li)) >>> 0
      for (let l = ra.length === 0 ? -1 : 0; l < ra.length; l++) {
        let b2 = b1
        if (l >= 0) for (const ri of raBuf.get(ra[l])) b2 = (b2 | bit(ri)) >>> 0
        mk(text3 + (k >= 0 ? 'L' + la[k].toUpperCase() : 'LL') + (l >= 0 ? 'R' + ra[l].toUpperCase() : 'RR'), b2)
      }
    }
    return
  }
  mk(text3, visBits)
}
function collectEmotions(out, P, prefix) {
  let splitter = '__'
  if (P.comment.trim()) {
    const m = RegLayerSplitter.exec(P.comment)
    if (m) splitter = m[1]
  }
  for (let aim = 0; aim < 8; aim++) {
    const sq = P.seqs[aim]
    if (!sq) continue
    for (const f of sq.frames) {
      if (f.name.startsWith('__')) continue
      let name = f.name
      if (name === '') {
        for (const l of f.layers) name = name === '' ? l.name : name + splitter + l.name
      }
      if (prefix) name = prefix + name
      out.push({ frame: f, key: name })
    }
  }
}
export function getEmotInfo(p, key) {
  if (!p.emotions) return null
  for (let i = p.emotions.length - 1; i >= 0; i--) if (p.emotions[i].key === key) return p.emotions[i]
  return null
}
