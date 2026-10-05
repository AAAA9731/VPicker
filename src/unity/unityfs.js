import { Reader } from './bytes'
import { lz4Decompress } from './lz4'
import { lzmaDecompress } from './lzma'
function decompress(src, outSize, type) {
  switch (type) {
    case 0:
      return src
    case 2:
    case 3:
      return lz4Decompress(src, outSize)
    case 1:
      return lzmaDecompress(src, outSize)
    default:
      throw new Error('未知压缩类型 ' + type)
  }
}
/** 解析 UnityFS 资源包，返回其中的各个文件（SerializedFile 与 .resS 等）。 */
export function readUnityFS(file) {
  const r = new Reader(file, false)
  const sig = r.cstring()
  if (sig !== 'UnityFS') throw new Error('不是 UnityFS 资源包: ' + sig)
  const version = r.u32()
  r.cstring() // unity version (5.x.x)
  r.cstring() // unity revision
  r.i64() // total size
  const compSize = r.u32()
  const uncompSize = r.u32()
  const flags = r.u32()
  if (version >= 7) r.align(16)
  let infoBytes
  const atEnd = (flags & 0x80) !== 0
  if (atEnd) {
    infoBytes = file.subarray(file.length - compSize, file.length)
  } else {
    infoBytes = r.bytes(compSize)
  }
  const info = new Reader(decompress(infoBytes, uncompSize, flags & 0x3f), false)
  info.bytes(16) // hash
  const blockCount = info.i32()
  const blocks = []
  for (let i = 0; i < blockCount; i++) blocks.push({ u: info.u32(), c: info.u32(), f: info.u16() })
  const nodeCount = info.i32()
  const nodes = []
  for (let i = 0; i < nodeCount; i++) nodes.push({ off: info.i64(), size: info.i64(), flags: info.u32(), path: info.cstring() })
  if (!atEnd && (flags & 0x200) !== 0) r.align(16)
  const total = blocks.reduce((a, b) => a + b.u, 0)
  const data = new Uint8Array(total)
  let dp = 0
  for (const b of blocks) {
    const comp = r.bytes(b.c)
    data.set(decompress(comp, b.u, b.f & 0x3f), dp)
    dp += b.u
  }
  return nodes.map((n) => ({ path: n.path, flags: n.flags, data: data.subarray(n.off, n.off + n.size) }))
}
