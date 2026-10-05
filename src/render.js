import { RegFacePrefix, getEmotInfo } from './pxl/person'
/** 创建画布的工厂；浏览器默认用 document，Node 测试里可替换成 @napi-rs/canvas。 */
export const canvasFactory = {
  create(w, h) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  },
}
/** 一个角色的图集像素与按需裁剪出的精灵缓存。 */
export class AtlasStore {
  chara
  atlasPixels
  sprites = new Map()
  constructor(chara, atlasPixels) {
    this.chara = chara
    this.atlasPixels = atlasPixels
  }
  sprite(key) {
    if (this.sprites.has(key)) return this.sprites.get(key)
    const img = this.chara.images.get(key)
    let out = null
    const px = img ? this.atlasPixels[img.atlas] : null
    if (img && px && img.w > 0 && img.h > 0) {
      out = canvasFactory.create(img.w, img.h)
      const ctx = out.getContext('2d')
      if ('data' in px) {
        const atlas = this.chara.atlases[img.atlas]
        const kx = atlas.width ? px.width / atlas.width : 1
        const ky = atlas.height ? px.height / atlas.height : 1
        if (kx === 1 && ky === 1) {
          const id = ctx.createImageData(img.w, img.h)
          for (let y = 0; y < img.h; y++) {
            const s = ((img.y + y) * px.width + img.x) * 4
            id.data.set(px.data.subarray(s, s + img.w * 4), y * img.w * 4)
          }
          ctx.putImageData(id, 0, 0)
        } else {
          const tmp = canvasFactory.create(px.width, px.height)
          tmp.getContext('2d').putImageData(new ImageData(px.data, px.width, px.height), 0, 0)
          ctx.drawImage(tmp, img.x * kx, img.y * ky, img.w * kx, img.h * ky, 0, 0, img.w, img.h)
        }
      } else {
        ctx.drawImage(px, img.x, img.y, img.w, img.h, 0, 0, img.w, img.h)
      }
    }
    this.sprites.set(key, out)
    return out
  }
}
function drawLayer(ctx, store, l, cx, cy, sx, sy) {
  if (!l.imgKey) return
  const sp = store.sprite(l.imgKey)
  if (!sp) return
  ctx.save()
  ctx.translate(cx, cy)
  if (l.rotR) ctx.rotate(l.rotR)
  ctx.scale(sx * l.zmx, sy * l.zmy)
  ctx.drawImage(sp, -sp.width / 2, -sp.height / 2)
  ctx.restore()
}
/** 以 (ox,oy) 为原点、(sx,sy) 为缩放绘制一个表情帧（RotaPF）。 */
function drawFrame(ctx, store, F, ox, oy, sx, sy) {
  for (const l of F.layers) {
    if (l.isGroup || l.alpha <= 0) continue
    drawLayer(ctx, store, l, ox + l.x * sx, oy + l.y * sy, sx, sy)
  }
}
/** 对应 EvEmotVisibility.drawTo：在 canvas 中心为原点绘制姿势 + 表情。 */
export function drawPose(ctx, store, p, emotion, cx, cy, scale) {
  const F = p.source
  let vis = p.visBits
  if (p.faceBits && emotion) {
    const m = RegFacePrefix.exec(emotion)
    if (m) vis = (vis | (p.faceBits.get(parseInt(m[1], 10)) ?? 0)) >>> 0
  }
  let emoIdx = 0
  for (let i = 0; i < F.layers.length; i++) {
    const layer = F.layers[i]
    const visible = (vis & ((1 << (i & 31)) >>> 0)) !== 0
    const isEmoSlot = (p.emoBits & ((1 << (i & 31)) >>> 0)) !== 0 && p.emotPoses !== null
    let faceFrame = null
    let ep = null
    if (isEmoSlot) {
      const cand = p.emotPoses[emoIdx++]
      if (visible && emotion !== null) {
        const info = getEmotInfo(p, emotion)
        if (info && info.frame.seq.pose === cand.pose) {
          faceFrame = info.frame
          ep = cand
        }
      }
    }
    ctx.globalAlpha = layer.alpha > 0 ? layer.alpha / 100 : 1
    if (!isEmoSlot) {
      if (visible && !layer.isGroup) drawLayer(ctx, store, layer, cx + layer.x * scale, cy + layer.y * scale, scale, scale)
    } else if (faceFrame && ep) {
      const n4 = layer.zmx * scale
      const ox = cx + layer.x * scale + n4 * ep.shiftx
      const oy = cy + layer.y * scale - n4 * ep.shifty
      drawFrame(ctx, store, faceFrame, ox, oy, n4, layer.zmy * scale)
    }
  }
  ctx.globalAlpha = 1
}
/** 只画表情帧本身（vp 右栏表情按钮的内容），自动居中缩放到 w×h 内。 */
export function drawFaceThumb(ctx, store, F, w, h) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const l of F.layers) {
    if (l.isGroup || l.alpha <= 0 || !l.imgKey) continue
    const im = store.chara.images.get(l.imgKey)
    const hw = (im.w * l.zmx) / 2,
      hh = (im.h * l.zmy) / 2
    x0 = Math.min(x0, l.x - hw)
    x1 = Math.max(x1, l.x + hw)
    y0 = Math.min(y0, l.y - hh)
    y1 = Math.max(y1, l.y + hh)
  }
  if (!isFinite(x0)) return
  const s = Math.min(w / (x1 - x0), h / (y1 - y0))
  drawFrame(ctx, store, F, w / 2 - ((x0 + x1) / 2) * s, h / 2 - ((y0 + y1) / 2) * s, s, s)
}
