import { Reader, utf8 } from './bytes'
import { readUnityFS } from './unityfs'
const CLASS_TEXTASSET = 49
const CLASS_TEXTURE2D = 28
function skipType(r, version, enableTree, isRef) {
  const classId = r.i32()
  if (version >= 16) r.bool() // stripped
  let scriptIdx = -1
  if (version >= 17) scriptIdx = r.i16()
  if (version >= 13) {
    if ((isRef && scriptIdx >= 0) || (version < 16 && classId < 0) || (version >= 16 && classId === 114)) r.bytes(16)
    r.bytes(16)
  }
  if (enableTree) {
    const nodeCount = r.i32()
    const strSize = r.i32()
    r.bytes(nodeCount * (version >= 19 ? 32 : 24))
    r.bytes(strSize)
    if (version >= 21) {
      if (isRef) {
        r.cstring()
        r.cstring()
        r.cstring()
      } else {
        const n = r.i32()
        r.bytes(n * 4)
      }
    }
  }
  return classId
}
export function readSerialized(buf) {
  const r = new Reader(buf, false)
  r.u32() // metadata size
  r.u32() // file size
  const version = r.u32()
  let dataOffset = r.u32()
  if (version < 9) throw new Error('SerializedFile 版本过旧: ' + version)
  const endian = r.u8()
  r.bytes(3)
  if (version >= 22) {
    r.u32() // metadata size
    r.i64() // file size
    dataOffset = r.i64()
    r.i64() // unknown
  }
  r.le = endian === 0
  if (version >= 7) r.cstring() // unity version
  if (version >= 8) r.i32() // target platform
  const enableTree = version >= 13 ? r.bool() : false
  const typeCount = r.i32()
  const typeClass = []
  for (let i = 0; i < typeCount; i++) typeClass.push(skipType(r, version, enableTree, false))
  if (version >= 7 && version < 14) r.i32() // bigIdEnabled
  const objCount = r.i32()
  const objects = []
  for (let i = 0; i < objCount; i++) {
    let pathId
    if (version < 14) pathId = r.i32()
    else {
      r.align(4)
      pathId = r.i64()
    }
    const start = version >= 22 ? r.i64() : r.u32()
    const size = r.u32()
    const typeId = r.i32()
    const classId = version < 16 ? r.u16() : typeClass[typeId]
    if (version < 11) r.u16()
    if (version >= 11 && version < 17) r.i16()
    if (version === 15 || version === 16) r.u8()
    objects.push({ pathId, classId, start: start + dataOffset, size })
  }
  return { objects, data: buf, le: r.le }
}
function resolveStream(nodes, path, off, size) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const n = nodes.find((x) => x.path === base || x.path.endsWith(base))
  if (!n) throw new Error('找不到外部数据流 ' + path)
  return n.data.subarray(off, off + size)
}
/** 解出一个资源包中的所有 TextAsset / Texture2D。 */
export function readBundleAssets(file) {
  const nodes = readUnityFS(file)
  const texts = []
  const textures = []
  for (const node of nodes) {
    if (node.path.endsWith('.resS') || node.path.endsWith('.resource')) continue
    let sf
    try {
      sf = readSerialized(node.data)
    } catch {
      continue
    }
    for (const o of sf.objects) {
      const r = new Reader(sf.data.subarray(o.start, o.start + o.size), sf.le)
      if (o.classId === CLASS_TEXTASSET) {
        const name = r.unityString()
        const n = r.i32()
        texts.push({ name, bytes: r.bytes(n).slice() })
      } else if (o.classId === CLASS_TEXTURE2D) {
        const name = r.unityString()
        r.i32() // forced fallback format
        r.bool()
        r.bool()
        r.align(4)
        const width = r.i32()
        const height = r.i32()
        r.i32() // complete image size
        r.i32() // mips stripped
        const format = r.i32()
        const mipCount = r.i32()
        r.bool()
        r.bool()
        r.bool()
        r.bool() // readable, preprocessed, ignoreMipmapLimit, streamingMipmaps
        r.align(4)
        r.unityString() // mipmap limit group name
        r.i32() // streaming mipmaps priority
        r.i32() // image count
        r.i32() // texture dimension
        r.i32()
        r.i32()
        r.f32()
        r.i32()
        r.i32()
        r.i32() // texture settings
        r.i32() // lightmap format
        r.i32() // color space
        const blob = r.i32()
        r.bytes(blob)
        r.align(4)
        const imgLen = r.i32()
        let data = r.bytes(imgLen)
        r.align(4)
        const off = r.u64()
        const size = r.u32()
        const path = r.unityString()
        if (imgLen === 0 && size > 0) data = resolveStream(nodes, path, off, size)
        textures.push({ name, width, height, format, mipCount, data: data.slice() })
      }
    }
  }
  return { texts, textures }
}
export { utf8 }
