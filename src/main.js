import { GameFiles, loadPerson } from './loader'
import { getEmotInfo } from './pxl/person'
import { buildPic, locatePic, parsePicLine } from './pic'
import { drawFaceThumb, drawPose } from './render'
import { createCustomPanel } from './custom'
import { createSpinePanel } from './spine'
import { createSpineController } from './spine/controller'
import { collectAllPoses, collectByEmotion, collectByPose, collectFrameRun, makeZip, safeFileName } from './batch'
const $ = (id) => document.getElementById(id)
const el = {
  pick: $('pick'),
  dirRow: $('dir-row'),
  dirInput: $('dir-input'),
  dirLoad: $('dir-load'),
  fallback: $('pick-fallback'),
  status: $('status'),
  progress: $('progress'),
  tabs: $('tabs'),
  modes: $('modes'),
  stage: $('stage'),
  poses: $('poses'),
  emots: $('emots'),
  preview: $('preview'),
  cmd: $('cmd'),
  flagN: $('flag-n'),
  copy: $('copy'),
  copyImg: $('copy-img'),
  saveImg: $('save-img'),
  bgMode: $('img-bg-mode'),
  bgColor: $('img-bg-color'),
  previewWrap: $('preview-wrap'),
  zoomBadge: $('zoom-badge'),
  msg: $('cmd-msg'),
  batch: $('batch'),
  batchList: $('batch-list'),
  batchCount: $('batch-count'),
  batchCopy: $('batch-copy'),
  batchZip: $('batch-zip'),
  cmdfileInput: $('cmdfile-input'),
  cmdfileList: $('cmdfile-list'),
}
// texture2ddecoder 只会把以 / 开头的路径按页面地址解析；相对路径（如 ./wasm）会被当成相对于脚本块，在打包产物里找不到文件
const wasmPath = new URL(import.meta.env.BASE_URL + 'wasm', document.baseURI).pathname
let gf = new GameFiles()
const loaded = new Map()
const loading = new Map()
let curKey = ''
/** 'person' 立绘 / 'other' 非立绘图片 / 'custom' 自定义图片 / 'spine' 动画视频 */
let mode = 'person'
const spinePanel = createSpinePanel({ onEnter: () => void spineView.enter(), onHide: () => spineView.hide() })
const curDefs = () => (mode === 'other' ? gf.others : gf.defs)
const findDef = (key) => gf.defs.find((d) => d.key === key) ?? gf.others.find((d) => d.key === key)
let curPose = null
let curEmotion = null
/** 同一组表情（listup）上次选中的表情，切换姿势时沿用，与游戏 vp 的行为一致 */
const emotMemory = new Map()
// 运行在 exe 自带的本地服务器上时：保持一个心跳连接（关闭标签页后服务器会自动退出），并把状态同步到命令行窗口
const onServer = !!document.querySelector('meta[name="aic-server"]')
const spineView = createSpineController({ wasmPath, onServer })
if (onServer) new EventSource('/__events')
function serverLog(text) {
  if (onServer) navigator.sendBeacon('/__log', text)
}
function setStatus(text, error = false) {
  if (!/\d+%/.test(text)) serverLog((error ? '错误：' : '状态：') + text)
  el.status.textContent = text
  el.status.classList.toggle('error', error)
}
function setMsg(text, error = false) {
  if (text) serverLog((error ? '错误：' : '') + text)
  el.msg.textContent = text
  el.msg.classList.toggle('error', error)
}
// 导入 / 重命名要写磁盘，只有 exe 自带服务器按路径加载游戏文件夹（gf.writable）时才可用
async function picApi(path, init) {
  const r = await fetch(path, init)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? '服务器返回 ' + r.status)
  return j.name
}
const customPanel = createCustomPanel({
  root: $('custom'),
  notify: (t, err) => customMsg(t, err),
  api: {
    get canWrite() {
      return !!gf.writable && gf.picDir
    },
    upload: (file, name) => picApi('/__pic/upload?name=' + encodeURIComponent(name), { method: 'POST', body: file }),
    rename: (from, to) => picApi('/__pic/rename?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to), { method: 'POST' }),
  },
})
function customMsg(text, error = false) {
  if (text) serverLog((error ? '错误：' : '') + text)
  $('custom-msg').textContent = text
  $('custom-msg').classList.toggle('error', error)
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
// ───────────── 选择文件 ─────────────
async function onFilesReady() {
  await gf.finish()
  loaded.clear()
  loading.clear()
  curKey = ''
  curPose = null
  curEmotion = null
  customPanel.setFiles(gf.pics)
  spineView.setFiles(gf)
  $('mode-custom').hidden = !gf.picDir
  if (!gf.defs.length && !gf.others.length && !gf.picDir && !gf.spineBundles.length) {
    setStatus('没有找到游戏素材。请选择 StreamingAssets 或其中的素材文件夹。', true)
    el.tabs.replaceChildren()
    el.modes.hidden = true
    el.stage.hidden = true
    $('custom').hidden = true
    spinePanel.hide()
    return
  }
  setStatus(`找到 ${gf.defs.length} 个角色立绘包、${gf.others.length} 个非立绘图片包、${gf.spineBundles.length} 个动画资源包` + (gf.picDir ? `、${gf.pics.size} 张自定义图片（SimplePatch_pic）。` : '。'))
  el.modes.hidden = false
  if (!gf.defs.length && !gf.others.length) return gf.picDir ? showCustom() : showSpine()
  await setMode(gf.defs.length ? 'person' : 'other')
}
function showCustom() {
  selectToken = {}
  spinePanel.hide()
  mode = 'custom'
  for (const b of Array.from(el.modes.children)) b.setAttribute('aria-selected', String(b.dataset.mode === 'custom'))
  el.tabs.replaceChildren()
  el.stage.hidden = true
  $('custom').hidden = false
}
function showSpine() {
  if (el.modes.hidden) return
  selectToken = {}
  mode = 'spine'
  for (const b of Array.from(el.modes.children)) b.setAttribute('aria-selected', String(b.dataset.mode === 'spine'))
  el.tabs.replaceChildren()
  el.stage.hidden = true
  $('custom').hidden = true
  spinePanel.open()
}
function applyMode(m) {
  selectToken = {}
  spinePanel.hide()
  $('custom').hidden = true
  el.stage.hidden = true
  mode = m
  el.stage.classList.toggle('other', m === 'other')
  document.querySelector(`input[name="batch-mode"][value="${m === 'other' ? 'run' : 'emotion'}"]`).checked = true
  for (const b of Array.from(el.modes.children)) b.setAttribute('aria-selected', String(b.dataset.mode === m))
  renderTabs()
}
async function setMode(m) {
  applyMode(m)
  const defs = curDefs()
  if (!defs.length) return
  curPose = null
  curEmotion = null
  await selectPerson(defs.find((d) => d.key === 'n')?.key ?? defs[0].key)
}
for (const b of Array.from(el.modes.children)) b.addEventListener('click', () => {
  const m = b.dataset.mode
  if (m === 'spine') return showSpine()
  if (mode === m) return
  if (m === 'custom') return showCustom()
  void setMode(m)
})
el.pick.addEventListener('click', async () => {
  if ('showDirectoryPicker' in window) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'aic-evimg', mode: 'read' })
      gf = new GameFiles()
      setStatus('正在扫描文件夹…')
      await gf.addDirHandle(dir)
      await onFilesReady()
    } catch (e) {
      if (e.name !== 'AbortError') setStatus('读取文件夹失败：' + e.message, true)
    }
  } else {
    el.fallback.click()
  }
})
el.fallback.addEventListener('change', async () => {
  if (!el.fallback.files) return
  gf = new GameFiles()
  await gf.addFileList(el.fallback.files)
  await onFilesReady()
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  // 把 PNG 拖进来 = 导入到 SimplePatch_pic（先给个名字，再打开重命名框）
  const dropped = Array.from(e.dataTransfer?.files ?? [])
  if (gf.picDir && dropped.length && dropped.every((f) => /\.png$/i.test(f.name))) {
    showCustom()
    await customPanel.importFiles(dropped)
    return
  }
  const items = e.dataTransfer?.items
  if (!items) return
  const entries = []
  for (const it of Array.from(items)) {
    const en = it.webkitGetAsEntry?.()
    if (en) entries.push(en)
  }
  gf = new GameFiles()
  setStatus('正在扫描文件夹…')
  for (const en of entries) await gf.addEntry(en)
  await onFilesReady()
})
// exe 自带服务器：能直接按路径读取游戏文件。路径来自 ?dir=、命令行 --dir=，或上次成功加载的路径
async function loadServerDir(dir) {
  setStatus('正在读取 ' + dir + ' …')
  try {
    const r = await fetch('/__dir/list?dir=' + encodeURIComponent(dir))
    const j = await r.json()
    if (!r.ok) {
      setStatus(j.error, true)
      return
    }
    el.dirInput.value = j.dir
    gf = new GameFiles()
    for (const n of j.names) {
      gf.files.set(n, async () => new File([await (await fetch('/__dir/file/' + encodeURIComponent(n))).arrayBuffer()], n))
    }
    gf.picDir = !!j.picDir
    gf.writable = true
    for (const n of j.pics ?? []) {
      gf.pics.set(n, async () => new File([await (await fetch('/__dir/pic/' + encodeURIComponent(n))).arrayBuffer()], n.split('/').pop(), { type: 'image/png' }))
    }
    await onFilesReady()
  } catch (e) {
    setStatus('读取路径失败：' + e.message, true)
  }
}
if (onServer) {
  el.dirRow.hidden = false
  el.dirLoad.addEventListener('click', () => el.dirInput.value.trim() && void loadServerDir(el.dirInput.value.trim()))
  el.dirInput.addEventListener('keydown', (e) => e.key === 'Enter' && el.dirLoad.click())
  void (async () => {
    const q = new URLSearchParams(location.search).get('dir')
    const cfg = await (await fetch('/__config')).json()
    const dir = q || cfg.dir
    if (dir) {
      el.dirInput.value = dir
      await loadServerDir(dir)
    }
  })()
}
// ───────────── 检查更新（仅 exe 自带服务器） ─────────────
async function checkForUpdate() {
  let u
  try {
    u = await (await fetch('/__update/check')).json()
  } catch {
    return
  }
  if (u.error || !u.newer || u.ignored) return
  const dlg = $('update-dialog')
  $('update-ver').textContent = 'v' + u.latest
  $('update-sub').textContent = `当前版本 v${u.current}。`
  $('update-notes').textContent = u.notes || '（没有更新说明）'
  $('update-page').href = u.url
  $('update-apply').hidden = !u.canSelfUpdate
  const msg = $('update-msg')
  $('update-later').onclick = () => dlg.close()
  $('update-ignore').onclick = () => {
    void fetch('/__update/ignore?v=' + encodeURIComponent(u.latest), { method: 'POST' })
    dlg.close()
  }
  $('update-apply').onclick = async () => {
    for (const b of dlg.querySelectorAll('button')) b.disabled = true
    msg.classList.remove('error')
    msg.textContent = '正在下载并安装，请稍候…'
    try {
      const r = await fetch('/__update/apply', { method: 'POST' })
      if (!r.ok) throw new Error((await r.json()).error)
      msg.textContent = '更新完成，正在重启…'
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1000))
        try {
          const c = await (await fetch('/__config', { cache: 'no-store' })).json()
          if (c.version === u.latest) return location.reload()
        } catch {}
      }
      msg.textContent = '没能自动重启，请手动重新打开 VPicker。'
    } catch (e) {
      msg.classList.add('error')
      msg.textContent = '更新失败：' + e.message
      for (const b of dlg.querySelectorAll('button')) b.disabled = false
    }
  }
  dlg.showModal()
}
if (onServer) void checkForUpdate()
// 仅开发模式：/?auto=1 从 dev 服务器的 /__game 读取文件（见 vite.config.ts）
if (import.meta.env.DEV && new URLSearchParams(location.search).has('auto')) {
  void (async () => {
    const names = await (await fetch('/__game')).json()
    gf = new GameFiles()
    for (const n of names) {
      gf.files.set(n, async () => new File([await (await fetch('/__game/' + encodeURIComponent(n))).arrayBuffer()], n))
    }
    await onFilesReady()
  })()
}
// ───────────── 角色 ─────────────
function renderTabs() {
  el.tabs.replaceChildren(
    ...curDefs().map((d) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tab'
      b.setAttribute('role', 'tab')
      b.dataset.key = d.key
      b.title = d.pxl
      b.innerHTML = ''
      b.append(d.key)
      if (d.name) {
        const s = document.createElement('small')
        s.textContent = d.name
        b.append(s)
      }
      b.addEventListener('click', () => void selectPerson(d.key))
      return b
    })
  )
  markTab()
}
function markTab() {
  for (const t of Array.from(el.tabs.children)) t.setAttribute('aria-selected', String(t.dataset.key === curKey))
}
function ensureLoaded(key) {
  const got = loaded.get(key)
  if (got) return Promise.resolve(got)
  let p = loading.get(key)
  if (!p) {
    const def = findDef(key)
    if (!def) return Promise.reject(new Error('没有角色 ' + key))
    p = loadPerson(gf, def, wasmPath, (f, label) => {
      el.progress.hidden = f >= 1
      el.progress.value = f
      if (f < 1) setStatus(`正在解包 ${key}：${label}（${Math.round(f * 100)}%）`)
    })
      .then((r) => {
        loaded.set(key, r)
        return r
      })
      .finally(() => {
        el.progress.hidden = true
      })
    loading.set(key, p)
    p.catch(() => loading.delete(key))
  }
  return p
}
async function selectPerson(key, pose, emotion) {
  const token = (selectToken = {})
  if (key !== curKey) {
    resetView()
    picked.clear()
    updatePicked()
  }
  curKey = key
  markTab()
  let lp = loaded.get(key)
  if (!lp) {
    setStatus(`正在解包 ${key} …（首次需要解码贴图，约几秒）`)
    el.stage.hidden = false
    await nextFrame()
    try {
      lp = await ensureLoaded(key)
    } catch (e) {
      setStatus(`加载 ${key} 失败：${e.message}`, true)
      return
    }
    if (token !== selectToken) return
  }
  setStatus(`${key}：${lp.person.poses.length} ${mode === 'other' ? '张图' : '个姿势'}`)
  el.stage.hidden = false
  renderPoseList(lp)
  const target = pose ?? lp.person.poses.find((p) => !p.dontAppearOnEditor) ?? lp.person.poses[0]
  if (target) selectPose(lp, target, emotion)
}
let selectToken = {}
// ───────────── 列表与缩略图 ─────────────
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      thumbObserver.unobserve(e.target)
      e.target._draw?.()
    }
  },
  { rootMargin: '200px' }
)
function makeItem(label, title, w, h, draw) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'item'
  b.title = title
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const s = document.createElement('span')
  s.textContent = label
  b.append(c, s)
  b._draw = () => draw(c.getContext('2d'))
  thumbObserver.observe(b)
  return b
}
function poseDims(p) {
  const pose = p.source.seq.pose
  return { w: pose.width, h: pose.height }
}
// 非立绘：Ctrl+点击多选，选中的图可在批处理里一起下载
const picked = new Set()
const selCount = $('sel-count')
function updatePicked() {
  selCount.textContent = String(picked.size)
  for (const b of Array.from(el.poses.children)) b.classList.toggle('picked', picked.has(b._pose))
}
function togglePicked(lp, p) {
  if (picked.has(p)) picked.delete(p)
  else picked.add(p)
  updatePicked()
  el.batch.open = true
  document.querySelector('input[name="batch-mode"][value="sel"]').checked = true
  refreshBatch()
}
function renderPoseList(lp) {
  const items = []
  lp.person.poses.forEach((p, i) => {
    if (p.dontAppearOnEditor) return
    const { w, h } = poseDims(p)
    const s = Math.min(96 / w, 120 / h)
    const b = makeItem(p.name, p.name, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), (ctx) => {
      drawPose(ctx, lp.store, p, p.emotions?.[0]?.key ?? null, ctx.canvas.width / 2, ctx.canvas.height / 2, s)
    })
    b.dataset.index = String(i)
    b.addEventListener('click', (e) => {
      if (mode === 'other' && (e.ctrlKey || e.metaKey)) return togglePicked(lp, p, b)
      selectPose(lp, p)
    })
    b.classList.toggle('picked', picked.has(p))
    b._pose = p
    items.push(b)
  })
  el.poses.replaceChildren(...items)
}
function renderEmotList(lp, p) {
  const list = p.emotions ?? []
  el.emots.replaceChildren(
    ...list.map((e) => {
      const b = makeItem(e.key, e.key, 96, 72, (ctx) => drawFaceThumb(ctx, lp.store, e.frame, 96, 72))
      b.dataset.key = e.key
      b.addEventListener('click', () => selectEmotion(lp, e.key))
      return b
    })
  )
  if (!list.length) el.emots.textContent = '这个姿势没有表情差分'
}
function markSelection(lp) {
  const idx = curPose ? lp.person.poses.indexOf(curPose) : -1
  for (const b of Array.from(el.poses.children)) b.setAttribute('aria-pressed', String(Number(b.dataset.index) === idx))
  for (const b of Array.from(el.emots.children)) b.setAttribute('aria-pressed', String(b.dataset.key === curEmotion))
  const sel = el.poses.querySelector('[aria-pressed="true"]')
  sel?.scrollIntoView({ block: 'nearest' })
  const se = el.emots.querySelector('[aria-pressed="true"]')
  se?.scrollIntoView({ block: 'nearest' })
}
// ───────────── 选择与指令 ─────────────
function selectPose(lp, p, emotion) {
  const listupChanged = !curPose || curPose.listup !== p.listup
  curPose = p
  if (emotion !== undefined && emotion !== null) curEmotion = emotion
  else {
    const mem = emotMemory.get(p.listup)
    curEmotion = mem && getEmotInfo(p, mem) ? mem : (p.emotions?.[0]?.key ?? null)
  }
  if (listupChanged || el.emots.children.length === 0) renderEmotList(lp, p)
  markSelection(lp)
  if (curEmotion && p.listup) emotMemory.set(p.listup, curEmotion)
  redraw(lp)
  writeCmd()
}
function selectEmotion(lp, key) {
  if (!curPose) return
  curEmotion = key
  emotMemory.set(curPose.listup, key)
  markSelection(lp)
  redraw(lp)
  writeCmd()
}
function redraw(lp) {
  if (!curPose) return
  const { w, h } = poseDims(curPose)
  const s = Math.min(1, 1100 / h)
  const c = el.preview
  c.width = Math.round(w * s)
  c.height = Math.round(h * s)
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, c.width, c.height)
  drawPose(ctx, lp.store, curPose, curEmotion, c.width / 2, c.height / 2, s)
  requestAnimationFrame(updateZoomBadge)
}
// 预览缩放：滚轮以鼠标位置为中心缩放，拖动平移，双击复位
const view = { z: 1, x: 0, y: 0 }
const hint = $('zoom-hint')
/** 预览左下角的倍率：画面上图片像素 / 原图像素（含 CSS 适配缩放和滚轮缩放）。 */
function updateZoomBadge() {
  const c = el.preview
  const w = c.getBoundingClientRect().width
  // 按物理像素算（系统缩放 150% 时 1 CSS 像素 = 1.5 物理像素），100% 即 1:1 真实大小
  el.zoomBadge.textContent = c.width && w ? `${Math.round(((w * (window.devicePixelRatio || 1)) / c.width) * 100)}%` : ''
}
new ResizeObserver(updateZoomBadge).observe(el.previewWrap)
window.addEventListener('resize', updateZoomBadge)
function applyView() {
  el.preview.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`
  updateZoomBadge()
  hint.textContent = view.z === 1 ? '' : `${Math.round(view.z * 100)}%（双击复位）`
}
function resetView() {
  view.z = 1
  view.x = view.y = 0
  applyView()
}
el.previewWrap.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const r = el.previewWrap.getBoundingClientRect()
    const cx = e.clientX - (r.left + r.width / 2)
    const cy = e.clientY - (r.top + r.height / 2)
    const z = Math.min(16, Math.max(0.2, view.z * Math.exp(-e.deltaY * 0.0015)))
    const k = z / view.z
    view.x = cx - (cx - view.x) * k
    view.y = cy - (cy - view.y) * k
    view.z = z
    if (Math.abs(z - 1) < 0.03) resetView()
    else applyView()
  },
  { passive: false }
)
let drag = null
el.previewWrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  drag = { x: e.clientX - view.x, y: e.clientY - view.y }
  el.previewWrap.setPointerCapture(e.pointerId)
  el.preview.classList.add('dragging')
})
el.previewWrap.addEventListener('pointermove', (e) => {
  if (!drag) return
  view.x = e.clientX - drag.x
  view.y = e.clientY - drag.y
  applyView()
})
const endDrag = () => {
  drag = null
  el.preview.classList.remove('dragging')
}
el.previewWrap.addEventListener('pointerup', endDrag)
el.previewWrap.addEventListener('pointercancel', endDrag)
el.previewWrap.addEventListener('dblclick', resetView)
let writing = false
function writeCmd() {
  if (!curPose) return
  if (mode !== 'person') {
    if (el.batch.open) refreshBatch()
    return
  }
  writing = true
  el.cmd.value = buildPic(curKey, curPose, curEmotion ?? '', el.flagN.checked).trimEnd()
  writing = false
  setMsg('')
  if (el.batch.open) refreshBatch()
}
el.flagN.addEventListener('change', () => {
  writeCmd()
  if (el.batch.open) refreshBatch()
})
el.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.cmd.value)
    setMsg('已复制到剪贴板')
  } catch {
    el.cmd.select()
    setMsg('浏览器不允许自动复制，请按 Ctrl+C', true)
  }
})
// ───────────── 导出图片 ─────────────
/** 以原始分辨率（1:1）渲染当前姿势 + 表情，返回 PNG。 */
function renderBlob(lp, pose, emotion) {
  const { w, h } = poseDims(pose)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  const bg = bgColor()
  if (bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
  }
  drawPose(ctx, lp.store, pose, emotion, w / 2, h / 2, 1)
  return new Promise((res) => c.toBlob(res, 'image/png'))
}
function exportBlob() {
  const lp = loaded.get(curKey)
  if (!lp || !curPose) return Promise.resolve(null)
  return renderBlob(lp, curPose, curEmotion)
}
el.copyImg.addEventListener('click', async () => {
  if (!loaded.get(curKey) || !curPose) {
    setMsg('还没有可导出的立绘', true)
    return
  }
  try {
    // 把 Promise 直接交给 ClipboardItem：Safari 要求在点击的同步阶段就写入剪贴板，不能先 await 再写
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })])
    setMsg('图片已复制到剪贴板')
  } catch (e) {
    setMsg('复制图片失败（需要 https 或 localhost，且浏览器允许剪贴板）：' + e.message, true)
  }
})
el.saveImg.addEventListener('click', async () => {
  const blob = await exportBlob()
  if (!blob || !curPose) {
    setMsg('还没有可导出的立绘', true)
    return
  }
  const name = `${curKey}_${curPose.name}__${curEmotion ?? ''}`.replace(/[\\/:*?"<>|]+/g, '_') + '.png'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  setMsg('已保存：' + name)
})
// 导出背景：透明 / 自选纯色；预览区同步显示，设置记在 localStorage
function bgColor() {
  return el.bgMode.value === 'solid' ? el.bgColor.value : null
}
function applyBg() {
  el.bgColor.disabled = el.bgMode.value !== 'solid'
  el.previewWrap.style.background = bgColor() ?? ''
  try {
    localStorage.setItem('vpicker-bg', JSON.stringify({ mode: el.bgMode.value, color: el.bgColor.value }))
  } catch {}
  setMsg('')
}
try {
  const saved = JSON.parse(localStorage.getItem('vpicker-bg') ?? 'null')
  if (saved) {
    el.bgMode.value = saved.mode === 'solid' ? 'solid' : 'none'
    if (/^#[0-9a-f]{6}$/i.test(saved.color)) el.bgColor.value = saved.color
  }
} catch {}
el.bgMode.addEventListener('change', applyBg)
el.bgColor.addEventListener('input', applyBg)
applyBg()
// 反向：输入/粘贴 PIC 指令 → 切换到对应姿势和表情
async function applyCmdText(text) {
  const c = parsePicLine(text)
  if (!c) {
    setMsg(text.trim() ? '不是角色立绘的 PIC 指令（&N / #N 全屏图不在此处理）' : '', !!text.trim())
    return
  }
  if (!gf.defs.some((d) => d.key === c.person)) {
    setMsg(`没有角色 "${c.person}" 的立绘包`, true)
    return
  }
  let lp
  try {
    if (!loaded.has(c.person)) {
      setStatus(`正在解包 ${c.person} …`)
      await nextFrame()
    }
    lp = await ensureLoaded(c.person)
  } catch (e) {
    setMsg('加载失败：' + e.message, true)
    return
  }
  const t = locatePic(lp.person, c.identifier)
  if (!t) {
    setMsg(`角色 ${c.person} 里没有这个姿势：${c.identifier.split('__')[0]}`, true)
    return
  }
  el.flagN.checked = /\bN\b/.test(c.rest)
  if (mode !== 'person') {
    applyMode('person')
    curKey = ''
  }
  if (curKey !== c.person) await selectPerson(c.person, t.pose, t.emotionFound ? t.emotion : null)
  else selectPose(lp, t.pose, t.emotionFound ? t.emotion : null)
  // 保留用户输入的原文，不被重新生成的格式覆盖
  writing = true
  el.cmd.value = text.trim()
  writing = false
  setMsg(t.emotionFound ? '已定位到该姿势和表情' : `姿势已定位，但没有表情 "${t.emotion}"`, !t.emotionFound)
}
el.cmd.addEventListener('input', () => {
  if (!writing) void applyCmdText(el.cmd.value)
})
// ───────────── cmd 文件 ─────────────
el.cmdfileInput.addEventListener('change', async () => {
  const f = el.cmdfileInput.files?.[0]
  if (!f) return
  const lines = (await f.text()).split(/\r?\n/)
  const btns = []
  lines.forEach((ln, i) => {
    if (!parsePicLine(ln)) return
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = `${i + 1}: ${ln.trim()}`
    b.addEventListener('click', () => {
      el.cmd.value = ln.trim()
      void applyCmdText(ln)
    })
    btns.push(b)
  })
  el.cmdfileList.replaceChildren(...btns)
  if (!btns.length) el.cmdfileList.textContent = '这个文件里没有角色立绘的 PIC 行'
})

// ───────────── 批处理 ─────────────
let batchItems = []
const batchMode = () => document.querySelector('input[name="batch-mode"]:checked').value

function refreshBatch() {
  const lp = loaded.get(curKey)
  batchItems = []
  if (lp && curPose) {
    const bm = batchMode()
    if (bm === 'emotion') batchItems = curEmotion ? collectByEmotion(lp.person, curEmotion) : []
    else if (bm === 'run') batchItems = collectFrameRun(lp.person, curPose)
    else if (bm === 'all') batchItems = collectAllPoses(lp.person)
    else if (bm === 'sel') batchItems = lp.person.poses.filter((p) => picked.has(p)).map((pose) => ({ pose, emotion: null }))
    else batchItems = collectByPose(curPose)
  }
  const label = { emotion: `表情 ${curEmotion ?? '—'}`, pose: `姿势 ${curPose?.name ?? '—'}`, run: `序列 ${curPose?.name ?? '—'}`, all: `图片包 ${curKey}`, sel: '已选图片' }[batchMode()]
  el.batchCount.textContent = `${label}：共 ${batchItems.length} 项`
  el.batchCopy.disabled = el.batchZip.disabled = batchItems.length === 0
  el.batchList.replaceChildren(
    ...batchItems.map((it) => {
      const { w, h } = poseDims(it.pose)
      const s = Math.min(84 / w, 110 / h)
      const label = batchMode() === 'pose' ? it.emotion : it.pose.name
      const b = makeItem(label, mode === 'other' ? it.pose.name : buildPic(curKey, it.pose, it.emotion).trim(), Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), (ctx) =>
        drawPose(ctx, lp.store, it.pose, it.emotion, ctx.canvas.width / 2, ctx.canvas.height / 2, s)
      )
      b.addEventListener('click', () => selectPose(lp, it.pose, it.emotion))
      return b
    })
  )
}
el.batch.addEventListener('toggle', () => el.batch.open && refreshBatch())
document.querySelectorAll('input[name="batch-mode"]').forEach((r) => r.addEventListener('change', refreshBatch))

const batchCommands = () => batchItems.map((it) => buildPic(curKey, it.pose, it.emotion, el.flagN.checked).trimEnd())

el.batchCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(batchCommands().join('\n'))
    setMsg(`已复制 ${batchItems.length} 条指令`)
  } catch (e) {
    setMsg('复制失败：' + e.message, true)
  }
})

el.batchZip.addEventListener('click', async () => {
  const lp = loaded.get(curKey)
  if (!lp || !batchItems.length) return
  const items = batchItems.slice()
  el.batchZip.disabled = true
  try {
    const files = []
    for (let i = 0; i < items.length; i++) {
      setMsg(`正在渲染 ${i + 1} / ${items.length} …`)
      await nextFrame()
      const blob = await renderBlob(lp, items[i].pose, items[i].emotion)
      const name = `${String(i + 1).padStart(items.length > 99 ? 3 : 2, '0')}_${safeFileName(mode === 'other' ? `${curKey}_${items[i].pose.name}` : `${curKey}_${items[i].pose.name}__${items[i].emotion}`)}.png`
      files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) })
    }
    if (mode === 'person') {
      const cmds = items.map((it) => buildPic(curKey, it.pose, it.emotion, el.flagN.checked).trimEnd())
      files.push({ name: 'pic.txt', data: new TextEncoder().encode(cmds.join('\r\n') + '\r\n') })
    }
    const zip = makeZip(files)
    const base = { emotion: `${curKey}_表情_${curEmotion}`, pose: `${curKey}_姿势_${curPose.name}`, run: `${curKey}_序列_${curPose.name}`, all: `${curKey}_全部`, sel: `${curKey}_已选` }[batchMode()]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(zip)
    a.download = safeFileName(base) + '.zip'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    setMsg(mode === 'person' ? `已打包 ${items.length} 张图片和 pic.txt` : `已打包 ${items.length} 张图片`)
  } catch (e) {
    setMsg('打包失败：' + e.message, true)
  } finally {
    el.batchZip.disabled = false
  }
})
