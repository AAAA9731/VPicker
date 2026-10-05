/**
 * LZMA 解码（Unity 资源包的 LZMA 块：5 字节属性头 + 原始码流，不含长度字段）。
 * 实现依据 LZMA SDK 的 LzmaSpec.cpp。
 */
const kNumBitModelTotalBits = 11
const kBitModelTotal = 1 << kNumBitModelTotalBits
const kNumMoveBits = 5
const PROB_INIT = kBitModelTotal >> 1
class RangeDecoder {
  src
  range = 0xffffffff
  code = 0
  pos
  constructor(src, start) {
    this.src = src
    this.pos = start
    if (src[this.pos++] !== 0) throw new Error('LZMA: 码流首字节应为 0')
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | src[this.pos++]) >>> 0
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this.src[this.pos++]) >>> 0
    }
  }
  decodeBit(probs, i) {
    const p = probs[i]
    const bound = ((this.range >>> kNumBitModelTotalBits) * p) >>> 0
    let bit
    if (this.code < bound) {
      this.range = bound
      probs[i] = p + ((kBitModelTotal - p) >>> kNumMoveBits)
      bit = 0
    } else {
      this.range = (this.range - bound) >>> 0
      this.code = (this.code - bound) >>> 0
      probs[i] = p - (p >>> kNumMoveBits)
      bit = 1
    }
    this.normalize()
    return bit
  }
  decodeDirect(n) {
    let res = 0
    while (n-- > 0) {
      this.range >>>= 1
      this.code = (this.code - this.range) >>> 0
      const t = 0 - (this.code >>> 31)
      this.code = (this.code + (this.range & t)) >>> 0
      res = ((res << 1) + (t + 1)) >>> 0
      this.normalize()
    }
    return res
  }
}
function bitTree(rc, probs, off, nBits) {
  let m = 1
  for (let i = 0; i < nBits; i++) m = (m << 1) + rc.decodeBit(probs, off + m)
  return m - (1 << nBits)
}
function bitTreeReverse(rc, probs, off, nBits) {
  let m = 1
  let sym = 0
  for (let i = 0; i < nBits; i++) {
    const b = rc.decodeBit(probs, off + m)
    m = (m << 1) + b
    sym |= b << i
  }
  return sym
}
class LenDecoder {
  choice = new Uint16Array(2).fill(PROB_INIT)
  low = new Uint16Array(16 << 3).fill(PROB_INIT)
  mid = new Uint16Array(16 << 3).fill(PROB_INIT)
  high = new Uint16Array(256).fill(PROB_INIT)
  decode(rc, posState) {
    if (rc.decodeBit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3)
    if (rc.decodeBit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3)
    return 16 + bitTree(rc, this.high, 0, 8)
  }
}
export function lzmaDecompress(src, outSize) {
  const d = src[0]
  if (d >= 9 * 5 * 5) throw new Error('LZMA: 非法属性字节')
  const lc = d % 9
  const lp = Math.floor(d / 9) % 5
  const pb = Math.floor(d / 45)
  const rc = new RangeDecoder(src, 5)
  const out = new Uint8Array(outSize)
  let op = 0
  const literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT)
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT)
  const posDecoders = new Uint16Array(1 + 114).fill(PROB_INIT)
  const align = new Uint16Array(16).fill(PROB_INIT)
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT)
  const isRep = new Uint16Array(12).fill(PROB_INIT)
  const isRepG0 = new Uint16Array(12).fill(PROB_INIT)
  const isRepG1 = new Uint16Array(12).fill(PROB_INIT)
  const isRepG2 = new Uint16Array(12).fill(PROB_INIT)
  const isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT)
  const lenDec = new LenDecoder()
  const repLenDec = new LenDecoder()
  let state = 0
  let rep0 = 0,
    rep1 = 0,
    rep2 = 0,
    rep3 = 0
  const pbMask = (1 << pb) - 1
  const lpMask = (1 << lp) - 1
  while (op < outSize) {
    const posState = op & pbMask
    if (rc.decodeBit(isMatch, (state << 4) + posState) === 0) {
      const prev = op > 0 ? out[op - 1] : 0
      const base = 0x300 * (((op & lpMask) << lc) + (prev >> (8 - lc)))
      let sym = 1
      if (state >= 7) {
        let matchByte = out[op - rep0 - 1]
        do {
          const mb = (matchByte >> 7) & 1
          matchByte <<= 1
          const bit = rc.decodeBit(literal, base + ((1 + mb) << 8) + sym)
          sym = (sym << 1) | bit
          if (mb !== bit) break
        } while (sym < 0x100)
      }
      while (sym < 0x100) sym = (sym << 1) | rc.decodeBit(literal, base + sym)
      out[op++] = sym & 0xff
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
      continue
    }
    let len
    if (rc.decodeBit(isRep, state) !== 0) {
      if (op === 0) throw new Error('LZMA: 数据损坏')
      if (rc.decodeBit(isRepG0, state) === 0) {
        if (rc.decodeBit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11
          out[op] = out[op - rep0 - 1]
          op++
          continue
        }
      } else {
        let dist
        if (rc.decodeBit(isRepG1, state) === 0) dist = rep1
        else {
          if (rc.decodeBit(isRepG2, state) === 0) dist = rep2
          else {
            dist = rep3
            rep3 = rep2
          }
          rep2 = rep1
        }
        rep1 = rep0
        rep0 = dist
      }
      len = repLenDec.decode(rc, posState)
      state = state < 7 ? 8 : 11
    } else {
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      len = lenDec.decode(rc, posState)
      state = state < 7 ? 7 : 10
      const lenState = len < 4 ? len : 3
      const slot = bitTree(rc, posSlot, lenState << 6, 6)
      if (slot < 4) rep0 = slot
      else {
        const numDirect = (slot >> 1) - 1
        let dist = ((2 | (slot & 1)) << numDirect) >>> 0
        if (slot < 14) dist = (dist + bitTreeReverse(rc, posDecoders, dist - slot, numDirect)) >>> 0
        else {
          dist = (dist + (rc.decodeDirect(numDirect - 4) << 4)) >>> 0
          dist = (dist + bitTreeReverse(rc, align, 0, 4)) >>> 0
        }
        rep0 = dist
        if (rep0 === 0xffffffff) break // 结束标记
      }
      if (rep0 >= op) throw new Error('LZMA: 非法距离')
    }
    len += 2
    if (op + len > outSize) len = outSize - op
    for (let i = 0; i < len; i++) {
      out[op] = out[op - rep0 - 1]
      op++
    }
  }
  if (op !== outSize) throw new Error(`LZMA: 输出不足 ${op}/${outSize}`)
  return out
}
