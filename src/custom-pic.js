/** SimplePatch 的 PIC_LOAD / PIC 指令生成（纯函数，便于测试）。 */
export const PIC_DIR = 'SimplePatch_pic'
/** 文件名（可带子目录）→ 默认 id：去掉目录和扩展名，非字母数字下划线的字符换成 _。 */
export function defaultId(rel) {
  const base = rel.split('/').pop().replace(/\.png$/i, '')
  return base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'pic'
}
/** id 必须是事件脚本里能当单个参数用的名字。 */
export const validId = (id) => /^[A-Za-z0-9_]+$/.test(id)
/** `PIC_LOAD <id> <文件> [原点x 原点y]`；文件名里有空格时无法写进事件脚本，返回 null。 */
export function buildPicLoad(id, rel, ox = 0, oy = 0) {
  if (/\s/.test(rel)) return null
  const org = ox || oy ? ` ${ox} ${oy}` : ''
  return `PIC_LOAD ${id} ${rel}${org}`
}
/** `PIC <层> <id> [额外参数]` */
export function buildPicShow(layer, id, extra = '') {
  return `PIC ${layer || '&1'} ${id}${extra.trim() ? ' ' + extra.trim() : ''}`
}
/** 同一批里重复的 id：返回重复的 id 集合。 */
export function duplicateIds(ids) {
  const seen = new Set()
  const dup = new Set()
  for (const i of ids) (seen.has(i) ? dup : seen).add(i)
  return dup
}

/** 游戏逻辑画面（IN.w × IN.h）：事件里的图片按这个坐标系摆放，窗口只会等比缩放到各分辨率。 */
export const GAME_W = 1280
export const GAME_H = 720
/** 游戏设置里的窗口宽度选项（UiCFG.Ascreen_width），高度恒为宽度 × 9 / 16（整数除法），所以只有 16:9 一种比例。 */
export const GAME_WIDTHS = [640, 800, 1024, 1280, 1400, 1600, 1768, 1920, 2160, 2340, 2560, 3200, 3840, 4320, 5120]
export const gameHeight = (w) => Math.trunc((w * 9) / 16)
/** 与游戏一致：宽度是 1280 的整数倍时标为「推荐」（像素不会被拉伸变糊）。 */
export const resolutionLabel = (w) => `${w}x${gameHeight(w)}` + (w % GAME_W === 0 ? '（推荐）' : '')
/**
 * 游戏里 PIC 只支持这几档缩放（EvDrawer）：`h` 标志 = 0.5 倍（GRP_HALF_SCALE），`PIC_MVA <层> ZOOM2/3/4` = 2/3/4 倍，两者相乘。
 * 没有任意倍率。每档给出要追加的 h 标志和 ZOOM 关键字。
 */
export const SCALES = [
  { value: 0.5, label: '0.5×', half: true, zoom: '' },
  { value: 1, label: '1×（原始）', half: false, zoom: '' },
  { value: 1.5, label: '1.5×', half: true, zoom: 'ZOOM3' },
  { value: 2, label: '2×', half: false, zoom: 'ZOOM2' },
  { value: 3, label: '3×', half: false, zoom: 'ZOOM3' },
  { value: 4, label: '4×', half: false, zoom: 'ZOOM4' },
]
/**
 * 图片在逻辑画面中占的百分比位置。(x, y) 是 `PIC_MV` 的坐标：逻辑像素，以画面中心为原点，y 向上为正。
 */
export function placeInScreen(imgW, imgH, x = 0, y = 0, scale = 1) {
  return {
    width: ((imgW * scale) / GAME_W) * 100,
    height: ((imgH * scale) / GAME_H) * 100,
    left: 50 + (x / GAME_W) * 100,
    top: 50 - (y / GAME_H) * 100,
  }
}
/** 预览里拖动了 (dxPct, dyPct)（占画面宽/高的百分比）→ 新的 PIC_MV 坐标（取整，限制在画面内）。 */
export function dragToPos(x, y, dxPct, dyPct) {
  const nx = Math.round(x + (dxPct / 100) * GAME_W)
  const ny = Math.round(y - (dyPct / 100) * GAME_H)
  return { x: Math.max(-GAME_W, Math.min(GAME_W, nx)), y: Math.max(-GAME_H, Math.min(GAME_H, ny)) }
}
/**
 * 生成事件脚本：PIC_LOAD（加载）、PIC（显示，缩放 0.5/1.5 用 h 标志）、PIC_MV（位置，时间 0 = 立即）、PIC_MVA ZOOMn（2~4 倍）。
 * 文件名含空格时返回 null。
 */
export function buildScript({ id, rel, layer = '&1', extra = '', x = 0, y = 0, scale = 1 }) {
  const load = buildPicLoad(id, rel)
  if (!load) return null
  const sc = SCALES.find((o) => o.value === scale) ?? SCALES[1]
  const lines = [load, buildPicShow(layer, id, (sc.half ? 'h' : '') + extra.trim())]
  const L = layer || '&1'
  if (x || y) lines.push(`PIC_MV ${L} ${x} ${y} 0`)
  if (sc.zoom) lines.push(`PIC_MVA ${L} ${sc.zoom} 0`)
  return lines
}

/** 文件名（不含 .png）：只允许字母、数字、_ -（服务器端同样限制，事件脚本里不能有空格）。 */
export const validFileBase = (b) => /^[A-Za-z0-9_-]+$/.test(b)
/** 把拖进来的文件名整理成合法的名字（不含扩展名）；整理后为空则用 pic。 */
export function sanitizeBase(name) {
  const b = name.replace(/\.png$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return b || 'pic'
}
/** 在已有文件名（相对路径集合，含 .png）里找一个不冲突的名字：base、base_1、base_2 … */
export function uniqueBase(base, existing, dir = '') {
  const has = (b) => [...existing].some((n) => n.toLowerCase() === (dir + b + '.png').toLowerCase())
  if (!has(base)) return base
  for (let i = 1; ; i++) if (!has(`${base}_${i}`)) return `${base}_${i}`
}
