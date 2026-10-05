/** 带位置指针的二进制读取器（可切换字节序）。 */
export class Reader {
  buf
  view
  pos = 0
  le
  constructor(buf, le = false) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.le = le
  }
  get length() {
    return this.buf.length
  }
  u8() {
    return this.buf[this.pos++]
  }
  i8() {
    return (this.buf[this.pos++] << 24) >> 24
  }
  bool() {
    return this.u8() !== 0
  }
  u16() {
    const v = this.view.getUint16(this.pos, this.le)
    this.pos += 2
    return v
  }
  i16() {
    const v = this.view.getInt16(this.pos, this.le)
    this.pos += 2
    return v
  }
  u32() {
    const v = this.view.getUint32(this.pos, this.le)
    this.pos += 4
    return v
  }
  i32() {
    const v = this.view.getInt32(this.pos, this.le)
    this.pos += 4
    return v
  }
  f32() {
    const v = this.view.getFloat32(this.pos, this.le)
    this.pos += 4
    return v
  }
  f64() {
    const v = this.view.getFloat64(this.pos, this.le)
    this.pos += 8
    return v
  }
  /** 64 位整数；超过 2^53 的值会丢精度，资源包偏移不会达到。 */
  i64() {
    const v = this.view.getBigInt64(this.pos, this.le)
    this.pos += 8
    return Number(v)
  }
  u64() {
    const v = this.view.getBigUint64(this.pos, this.le)
    this.pos += 8
    return Number(v)
  }
  bytes(n) {
    const s = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return s
  }
  align(n) {
    const m = this.pos % n
    if (m) this.pos += n - m
  }
  cstring() {
    let e = this.pos
    while (this.buf[e] !== 0) e++
    const s = utf8(this.buf.subarray(this.pos, e))
    this.pos = e + 1
    return s
  }
  /** Unity 的 string：int32 长度 + 内容 + 4 字节对齐 */
  unityString() {
    const n = this.i32()
    const s = utf8(this.bytes(n))
    this.align(4)
    return s
  }
}
const dec = new TextDecoder('utf-8')
export function utf8(b) {
  return dec.decode(b)
}
