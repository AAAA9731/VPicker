import { GAME_H, GAME_W, GAME_WIDTHS, SCALES, buildPicLoad, buildScript, defaultId, dragToPos, duplicateIds, gameHeight, placeInScreen, resolutionLabel, sanitizeBase, uniqueBase, validFileBase, validId } from './custom-pic'
/**
 * 「自定义图片」面板：列出游戏 StreamingAssets/SimplePatch_pic 里的 PNG（SimplePatch 的 PicLoad 补丁读取的文件夹），
 * 点选后在 16:9 的游戏画面预览里摆放（拖动 = PIC_MV 位置，缩放 = 游戏支持的几档），生成 PIC_LOAD / PIC / PIC_MV / PIC_MVA 指令。
 */
export function createCustomPanel({ root, notify, api }) {
  const $ = (sel) => root.querySelector(sel)
  const el = {
    list: $('#custom-list'),
    hint: $('#custom-hint'),
    stage: $('#custom-stage'),
    win: $('#custom-window'),
    zoomHint: $('#custom-zoom-hint'),
    screen: $('#custom-screen'),
    preview: $('#custom-preview'),
    canvas: $('#custom-canvas'),
    badge: $('#custom-badge'),
    res: $('#custom-res'),
    info: $('#custom-info'),
    id: $('#custom-id'),
    x: $('#custom-ox'),
    y: $('#custom-oy'),
    center: $('#custom-center'),
    scale: $('#custom-scale'),
    layer: $('#custom-layer'),
    extra: $('#custom-extra'),
    out: $('#custom-out'),
    copy: $('#custom-copy'),
    copyLoad: $('#custom-copy-load'),
    copyAll: $('#custom-copy-all'),
  }
  let pics = new Map()
  let cur = null
  let urls = []
  const revoke = () => {
    for (const u of urls) URL.revokeObjectURL(u)
    urls = []
  }
  const num = (input) => Math.round(Number(input.value) || 0)
  const curScale = () => Number(el.scale.value) || 1

  // 预览窗口：16:9 的游戏画面（1280×720 逻辑像素）；分辨率只影响「实际显示尺寸」的提示，画面比例恒定
  for (const w of GAME_WIDTHS) el.res.add(new Option(resolutionLabel(w), String(w)))
  for (const s of SCALES) el.scale.add(new Option(s.label, String(s.value)))
  el.scale.value = '1'
  try {
    const saved = Number(localStorage.getItem('vpicker-game-width'))
    el.res.value = String(GAME_WIDTHS.includes(saved) ? saved : GAME_W)
  } catch {
    el.res.value = String(GAME_W)
  }

  // 按游戏当前分辨率（gw × gh）真实渲染一遍，再由浏览器拉伸到预览窗口：分辨率越低越糊，和游戏里把低分辨率窗口放大的效果一致
  function layoutPreview() {
    const img = el.preview
    const gw = Number(el.res.value)
    const gh = gameHeight(gw)
    const c = el.canvas
    // 窗口按真实像素大小显示：游戏分辨率是多少，画面就是多少个（CSS）像素宽（+2×2px 的边框）；放不下时用滚轮缩小、拖动平移
    // 系统缩放（devicePixelRatio，如 150%）下 1 CSS 像素 ≠ 1 物理像素，要按物理像素算才和游戏窗口一样大
    el.win.style.width = gw / window.devicePixelRatio + 4 + 'px'
    if (c.width !== gw) c.width = gw
    if (c.height !== gh) c.height = gh
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, gw, gh)
    if (!img.naturalWidth) {
      updateBadge()
      return
    }
    const k = curScale()
    const r = gw / GAME_W
    const w = img.naturalWidth * k * r
    const h = img.naturalHeight * k * r
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, gw / 2 + num(el.x) * r - w / 2, gh / 2 - num(el.y) * r - h / 2, w, h)
    el.info.textContent = `${cur}　${img.naturalWidth}×${img.naturalHeight}　在 ${gw}x${gh} 下约显示 ${Math.round(w)}×${Math.round(h)} 像素（逻辑画面 ${GAME_W}×${GAME_H}，在预览里拖动可调整位置）`
    updateBadge()
  }
  // 窗口以外的区域：和其他预览一样，滚轮缩放（以鼠标位置为中心）、拖动平移、双击复位
  const view = { z: 1, x: 0, y: 0 }
  function applyView() {
    el.win.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`
    el.zoomHint.textContent = view.z === 1 ? '' : `${Math.round(view.z * 100)}%（双击复位）`
    updateBadge()
  }
  function resetView() {
    view.z = 1
    view.x = view.y = 0
    applyView()
  }
  el.stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = el.stage.getBoundingClientRect()
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
  let pan = null
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === el.canvas || e.target.closest('select, input, button')) return
    pan = { x: e.clientX - view.x, y: e.clientY - view.y }
    el.stage.setPointerCapture(e.pointerId)
    el.stage.classList.add('dragging')
  })
  el.stage.addEventListener('pointermove', (e) => {
    if (!pan) return
    view.x = e.clientX - pan.x
    view.y = e.clientY - pan.y
    applyView()
  })
  const endPan = () => {
    pan = null
    el.stage.classList.remove('dragging')
  }
  el.stage.addEventListener('pointerup', endPan)
  el.stage.addEventListener('pointercancel', endPan)
  el.stage.addEventListener('dblclick', resetView)
  // 左下角倍率：预览窗口相对游戏真实大小的比例。游戏窗口在所选分辨率下有多少物理像素宽，预览就是多少时才是 100%（和游戏窗口完全一样大）
  function updateBadge() {
    const w = el.screen.getBoundingClientRect().width
    const gw = Number(el.res.value)
    const dpr = window.devicePixelRatio || 1
    el.badge.textContent = w ? `${Math.round(((w * dpr) / gw) * 100)}%` : ''
  }
  new ResizeObserver(updateBadge).observe(el.screen)
  function write() {
    layoutPreview()
    if (!cur) {
      el.out.value = ''
      return
    }
    const id = el.id.value.trim()
    if (!validId(id)) {
      el.out.value = ''
      notify('id 只能包含字母、数字和下划线', true)
      return
    }
    const lines = buildScript({ id, rel: cur, layer: el.layer.value.trim(), extra: el.extra.value, x: num(el.x), y: num(el.y), scale: curScale() })
    if (!lines) {
      el.out.value = ''
      notify('文件名里有空格，事件脚本无法引用；请先重命名文件', true)
      return
    }
    el.out.value = lines.join('\n')
    notify('')
  }
  el.res.addEventListener('change', () => {
    try {
      localStorage.setItem('vpicker-game-width', el.res.value)
    } catch {}
    layoutPreview()
  })
  for (const i of [el.id, el.x, el.y, el.scale, el.layer, el.extra]) i.addEventListener('input', write)
  el.center.addEventListener('click', () => {
    el.x.value = el.y.value = '0'
    write()
  })

  // 在预览里拖动图片 = 改 PIC_MV 的位置
  let drag = null
  el.canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !cur) return
    e.preventDefault()
    drag = { px: e.clientX, py: e.clientY, x: num(el.x), y: num(el.y) }
    el.canvas.setPointerCapture(e.pointerId)
    el.canvas.classList.add('dragging')
  })
  el.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return
    const r = el.screen.getBoundingClientRect()
    const p = dragToPos(drag.x, drag.y, ((e.clientX - drag.px) / r.width) * 100, ((e.clientY - drag.py) / r.height) * 100)
    el.x.value = String(p.x)
    el.y.value = String(p.y)
    write()
  })
  const endDrag = () => {
    drag = null
    el.canvas.classList.remove('dragging')
  }
  el.canvas.addEventListener('pointerup', endDrag)
  el.canvas.addEventListener('pointercancel', endDrag)
  el.canvas.addEventListener('dragstart', (e) => e.preventDefault())

  const fileOf = (rel) => pics.get(rel)()
  async function select(rel, btn) {
    cur = rel
    for (const b of Array.from(el.list.children)) b.setAttribute('aria-pressed', String(b.dataset.rel === rel))
    el.id.value = defaultId(rel)
    el.x.value = el.y.value = '0'
    el.scale.value = '1'
    const url = URL.createObjectURL(await fileOf(rel))
    urls.push(url)
    el.preview.onload = layoutPreview
    el.preview.src = url
    write()
  }

  // ───────────── 列表、重命名、导入 ─────────────
  const thumbs = new Map() // 相对路径 → 缩略图 blob URL
  function thumbUrl(rel) {
    let u = thumbs.get(rel)
    if (u) return Promise.resolve(u)
    return fileOf(rel).then((f) => {
      u = URL.createObjectURL(f)
      thumbs.set(rel, u)
      return u
    })
  }
  const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '')
  const baseOf = (rel) => rel.slice(dirOf(rel).length).replace(/\.png$/i, '')
  function render() {
    el.copyAll.disabled = pics.size === 0
    el.hint.hidden = pics.size > 0
    const items = [...pics.keys()].sort().map((rel) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'item'
      b.title = rel + (api.canWrite ? '\n长按重命名' : '')
      b.dataset.rel = rel
      b.setAttribute('aria-pressed', String(rel === cur))
      const img = document.createElement('img')
      const sp = document.createElement('span')
      sp.textContent = rel
      b.append(img, sp)
      void thumbUrl(rel).then((u) => (img.src = u))
      // 长按（约 0.5 秒）重命名，和文件管理器里的习惯一样；长按触发后吞掉随后的点击
      let timer = 0
      let longPressed = false
      let start = null
      const cancel = () => clearTimeout(timer)
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        longPressed = false
        start = { x: e.clientX, y: e.clientY }
        timer = setTimeout(() => {
          longPressed = true
          startRename(rel)
        }, 500)
      })
      b.addEventListener('pointermove', (e) => start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 && cancel())
      b.addEventListener('pointerup', cancel)
      b.addEventListener('pointerleave', cancel)
      b.addEventListener('pointercancel', cancel)
      b.addEventListener('contextmenu', (e) => longPressed && e.preventDefault())
      b.addEventListener('click', (e) => {
        if (longPressed) {
          longPressed = false
          e.preventDefault()
          return
        }
        void select(rel, b)
      })
      return b
    })
    el.list.replaceChildren(...items)
  }
  /** 把该项的文件名换成输入框；回车 / 失去焦点确认，Esc 取消。 */
  function startRename(rel) {
    if (!api.canWrite) {
      notify('重命名要改磁盘上的文件，请用 VPicker.exe 按路径加载游戏文件夹（浏览器的只读选择框不能改文件）', true)
      return
    }
    const btn = [...el.list.children].find((b) => b.dataset.rel === rel)
    if (!btn) return
    const sp = btn.querySelector('span')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'rename'
    input.value = baseOf(rel)
    input.spellcheck = false
    input.title = '字母、数字、_ -；回车确认，Esc 取消（扩展名 .png 不变）'
    sp.replaceWith(input)
    btn.title = ''
    input.focus()
    input.select()
    let done = false
    const finish = async (commit) => {
      if (done) return
      done = true
      const base = input.value.trim()
      if (!commit || base === baseOf(rel)) return render()
      if (!validFileBase(base)) {
        notify('文件名只能包含字母、数字、_ 和 -（事件脚本里不能有空格）', true)
        return render()
      }
      const target = dirOf(rel) + base + '.png'
      if ([...pics.keys()].some((n) => n !== rel && n.toLowerCase() === target.toLowerCase())) {
        notify('已经有同名文件了：' + target, true)
        return render()
      }
      try {
        const name = await api.rename(rel, base + '.png')
        moveEntry(rel, name)
        notify(`已重命名：${rel} → ${name}`)
      } catch (e) {
        notify('重命名失败：' + e.message, true)
        render()
      }
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') void finish(true)
      else if (e.key === 'Escape') void finish(false)
    })
    input.addEventListener('blur', () => void finish(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
  }
  /** 重命名后同步内存里的表和当前选中项。 */
  function moveEntry(from, to) {
    const get = pics.get(from)
    pics.delete(from)
    pics.set(to, get)
    const u = thumbs.get(from)
    if (u) {
      thumbs.delete(from)
      thumbs.set(to, u)
    }
    if (cur === from) {
      if (el.id.value === defaultId(from)) el.id.value = defaultId(to)
      cur = to
    }
    render()
    write()
  }
  /** 拖进来的 PNG：先分配一个名字（取原文件名，整理成合法字符，重名加序号）写进 SimplePatch_pic，再立刻打开重命名框。 */
  async function importFiles(files) {
    if (!api.canWrite) {
      notify('导入图片要把文件写进游戏文件夹，请用 VPicker.exe 按路径加载游戏文件夹（浏览器的只读选择框不能写文件）', true)
      return
    }
    const pngs = files.filter((f) => /\.png$/i.test(f.name))
    if (!pngs.length) {
      notify('只能导入 PNG 图片', true)
      return
    }
    let last = null
    for (const f of pngs) {
      const base = uniqueBase(sanitizeBase(f.name), pics.keys())
      try {
        const name = await api.upload(f, base + '.png')
        pics.set(name, async () => f)
        last = name
      } catch (e) {
        notify(`导入 ${f.name} 失败：${e.message}`, true)
      }
    }
    if (!last) return
    render()
    notify(`已导入 ${pngs.length > 1 ? pngs.length + ' 张图片；' : ''}${last}（先给了个名字，可直接改）`)
    const btn = [...el.list.children].find((b) => b.dataset.rel === last)
    btn?.scrollIntoView({ block: 'nearest' })
    await select(last, btn)
    startRename(last)
  }
  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text)
      notify(msg)
    } catch (e) {
      notify('复制失败：' + e.message, true)
    }
  }
  el.copy.addEventListener('click', () => el.out.value && void copy(el.out.value, '已复制指令'))
  el.copyLoad.addEventListener('click', () => el.out.value && void copy(el.out.value.split('\n')[0], '已复制 PIC_LOAD 指令'))
  el.copyAll.addEventListener('click', () => {
    const rels = [...pics.keys()].sort()
    const ids = rels.map(defaultId)
    const dup = duplicateIds(ids)
    const lines = []
    let skipped = 0
    rels.forEach((rel, i) => {
      const l = buildPicLoad(ids[i], rel)
      if (l) lines.push(l)
      else skipped++
    })
    const note = (dup.size ? `；id 重复：${[...dup].join('、')}（请改文件名）` : '') + (skipped ? `；${skipped} 个文件名含空格已跳过` : '')
    void copy(lines.join('\n'), `已复制 ${lines.length} 条 PIC_LOAD${note}`)
  })
  // 浏览器/系统缩放改变时 devicePixelRatio 会变
  window.addEventListener('resize', layoutPreview)
  layoutPreview()
  return {
    /** files: Map<相对路径, () => Promise<File>> */
    setFiles(files) {
      revoke()
      for (const u of thumbs.values()) URL.revokeObjectURL(u)
      thumbs.clear()
      pics = files
      cur = null
      el.preview.removeAttribute('src')
      layoutPreview()
      el.info.textContent = ''
      el.out.value = ''
      render()
    },
    importFiles,
  }
}
