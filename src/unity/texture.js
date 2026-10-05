import * as t2d from 'texture2ddecoder-wasm'
let inited = null
/** 浏览器里需要把 texture2ddecoder-wasm 的 wasm 目录放到 wasmPath（见 package.json 的 postinstall）。 */
export function initDecoder(wasmPath) {
  if (!inited) inited = t2d.initialize(wasmPath ? { wasmPath } : undefined)
  return inited
}
// Unity TextureFormat 枚举
const F_RGB24 = 3,
  F_RGBA32 = 4,
  F_ARGB32 = 5,
  F_BGRA32 = 14
const F_DXT1 = 10,
  F_DXT5 = 12,
  F_BC7 = 25
const F_DXT1_CRUNCHED = 28,
  F_DXT5_CRUNCHED = 29
function bgraToRgbaFlipY(bgra, w, h) {
  const out = new Uint8ClampedArray(w * h * 4)
  const stride = w * 4
  for (let y = 0; y < h; y++) {
    // Unity 贴图以左下角为原点，转成左上原点
    let s = (h - 1 - y) * stride
    let d = y * stride
    for (let x = 0; x < w; x++, s += 4, d += 4) {
      out[d] = bgra[s + 2]
      out[d + 1] = bgra[s + 1]
      out[d + 2] = bgra[s]
      out[d + 3] = bgra[s + 3]
    }
  }
  return out
}
function rawToRgbaFlipY(src, w, h, order) {
  const bpp = order === 'rgb' ? 3 : 4
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    let s = (h - 1 - y) * w * bpp
    let d = y * w * 4
    for (let x = 0; x < w; x++, s += bpp, d += 4) {
      switch (order) {
        case 'rgba':
          out[d] = src[s]
          out[d + 1] = src[s + 1]
          out[d + 2] = src[s + 2]
          out[d + 3] = src[s + 3]
          break
        case 'argb':
          out[d] = src[s + 1]
          out[d + 1] = src[s + 2]
          out[d + 2] = src[s + 3]
          out[d + 3] = src[s]
          break
        case 'bgra':
          out[d] = src[s + 2]
          out[d + 1] = src[s + 1]
          out[d + 2] = src[s]
          out[d + 3] = src[s + 3]
          break
        case 'rgb':
          out[d] = src[s]
          out[d + 1] = src[s + 1]
          out[d + 2] = src[s + 2]
          out[d + 3] = 255
          break
      }
    }
  }
  return out
}
/** 把 Texture2D 解码成左上原点的 RGBA 像素。 */
export async function decodeTexture(tex, onStep) {
  await initDecoder()
  const { width: w, height: h } = tex
  let data = tex.data
  let bgra
  switch (tex.format) {
    case F_DXT5_CRUNCHED:
    case F_DXT1_CRUNCHED: {
      await onStep?.('解压 Crunch')
      const unpacked = await t2d.unpack_unity_crunch(data)
      if (!unpacked) throw new Error('Crunch 解包失败')
      await onStep?.('解码 DXT 图像')
      bgra = await (tex.format === F_DXT5_CRUNCHED ? t2d.decode_bc3 : t2d.decode_bc1)(unpacked, w, h)
      break
    }
    case F_DXT5:
      bgra = await t2d.decode_bc3(data, w, h)
      break
    case F_DXT1:
      bgra = await t2d.decode_bc1(data, w, h)
      break
    case F_BC7:
      bgra = await t2d.decode_bc7(data, w, h)
      break
    case F_RGBA32:
      return { width: w, height: h, data: rawToRgbaFlipY(data, w, h, 'rgba') }
    case F_ARGB32:
      return { width: w, height: h, data: rawToRgbaFlipY(data, w, h, 'argb') }
    case F_BGRA32:
      return { width: w, height: h, data: rawToRgbaFlipY(data, w, h, 'bgra') }
    case F_RGB24:
      return { width: w, height: h, data: rawToRgbaFlipY(data, w, h, 'rgb') }
    default:
      throw new Error('暂不支持的贴图格式 ' + tex.format)
  }
  if (!bgra) throw new Error('贴图解码失败 (格式 ' + tex.format + ')')
  data = bgra
  await onStep?.('转换像素')
  return { width: w, height: h, data: bgraToRgbaFlipY(bgra, w, h) }
}
