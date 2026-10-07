import { readSpineCatalog, loadSpineResource } from './resources'
import { samplePose } from './pose'
import { createTriangleRenderer } from './webgl'
import { exportPlan, sourceTime } from './timing'
import { createSkinCombinations } from './skin-combinations'

export function createSpineController({ wasmPath, onServer }) {
  const $ = (id) => document.getElementById(id)
  let files, catalog, active = false, generation = 0, resource, selected, renderer, camera, playing = false, raf = 0, lastTick = 0, capabilities, exporting, loading = false
  const canvas = $('spine-canvas')
  const state = (text, error = false) => { $('spine-state').textContent = text; $('spine-state').classList.toggle('error', error) }
  const animation = () => resource?.rig.animations.find((item) => item.name === $('spine-animation').value)
  const length = () => animation()?.duration || 0
  let skinProfiles = [], skinSelection = []
  const skin = () => [...skinSelection]
  const busy = (value) => {
    const locked = value || loading || !!exporting
    for (const id of ['spine-animation', 'spine-skin', 'spine-play', 'spine-seek', 'spine-fit', 'spine-format', 'spine-resolution', 'spine-fps', 'spine-speed', 'spine-start', 'spine-duration', 'spine-loop', 'spine-background']) $(id).disabled = locked || !resource
    for (const select of $('spine-skin-parts').querySelectorAll('select')) select.disabled = locked || !resource
    $('spine-export-video').disabled = locked || !resource || !capabilities?.available
    $('spine-cancel').hidden = !value || !exporting
  }
  function stop() { playing = false; cancelAnimationFrame(raf); $('spine-play').textContent = '播放' }
  function render(time = Number($('spine-seek').value)) {
    if (!renderer || !active) return
    renderer.render(samplePose(resource.rig, animation()?.name, time, skin()), camera, 960, 540, $('spine-background').value)
    $('spine-seek').value = time
    $('spine-time').textContent = `${time.toFixed(2)} / ${length().toFixed(2)} 秒`
  }
  function fit() {
    if (!resource) return
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (let i = 0; i <= 40; i++) {
      const b = samplePose(resource.rig, animation()?.name, length() * i / 40, skin()).bounds
      if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) continue
      bounds.minX = Math.min(bounds.minX, b.minX); bounds.minY = Math.min(bounds.minY, b.minY)
      bounds.maxX = Math.max(bounds.maxX, b.maxX); bounds.maxY = Math.max(bounds.maxY, b.maxY)
    }
    camera = Number.isFinite(bounds.minX) ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, height: Math.max(10, bounds.maxY - bounds.minY, (bounds.maxX - bounds.minX) * 9 / 16) * 1.15 } : { x: 0, y: 0, height: 1000 }
    render()
  }
  function resetAnimation() {
    stop()
    $('spine-seek').max = Math.max(length(), 0.001)
    $('spine-seek').value = 0
    $('spine-duration').value = Math.min(120, Math.max(0.01, length() / (Number($('spine-speed').value) || 1))).toFixed(2)
    fit()
  }
  function applySkinProfile() {
    const profile = skinProfiles[Number($('spine-skin').value)]
    $('spine-skin-parts').replaceChildren()
    if (!profile) { skinSelection = []; return }
    const selections = new Map(profile.groups.map((group) => [group.id, group.initial]))
    const update = () => { skinSelection = [...new Set([...profile.base, ...selections.values()].filter(Boolean))] }
    for (const group of profile.groups) {
      const label = document.createElement('label'), select = document.createElement('select')
      label.className = 'spine-field'; label.append(document.createTextNode(group.title))
      for (const [value, text] of [['', '不叠加'], ...group.names.map((name) => [name, name])]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option)
      }
      select.value = group.initial
      select.addEventListener('change', () => { selections.set(group.id, select.value); update(); fit() })
      label.append(select); $('spine-skin-parts').append(label)
    }
    update()
    $('spine-skin-options').hidden = !profile.groups.length
    $('spine-skin-hint').textContent = profile.configured ? '按游戏配置组合基础皮肤和叠加部件；状态切换与多轨动画混合未复现。' : profile.groups.length ? '按部件结构补齐初始组合；没有游戏预设的资源可展开调整。' : '此资源无需叠加额外皮肤。'
  }
  function list() {
    const available = catalog.entries
    for (const option of $('spine-group').options) option.disabled = !!option.value && !available.some((entry) => entry.group === option.value)
    if ($('spine-group').selectedOptions[0]?.disabled) $('spine-group').value = ''
    const query = $('spine-search').value.toLowerCase(), group = $('spine-group').value
    const entries = available.filter((entry) => (!group || entry.group === group) && entry.name.toLowerCase().includes(query))
    $('spine-list').replaceChildren(...entries.map((entry) => {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = entry.name; button.title = entry.group
      button.setAttribute('aria-pressed', String(selected?.id === entry.id))
      button.disabled = !!exporting
      button.addEventListener('click', () => void select(entry))
      return button
    }))
    if (!entries.length) $('spine-list').textContent = '没有匹配的动画资源。'
  }
  async function select(entry) {
    if (exporting || !active) return
    const token = ++generation
    loading = true; stop(); busy(true)
    state('读取 ' + entry.name + ' 的贴图与骨骼…')
    try {
      const next = await loadSpineResource(files, entry, wasmPath)
      if (token !== generation || !active) return
      renderer?.dispose(); renderer = null; resource = next; selected = entry
      renderer = createTriangleRenderer(canvas, resource.pages)
      const option = (name, text = name) => { const item = document.createElement('option'); item.value = name; item.textContent = text; return item }
      $('spine-animation').replaceChildren(...resource.rig.animations.map((a) => option(a.name, `${a.name} · ${a.duration.toFixed(2)} 秒`)))
      if (resource.rig.animations.some((a) => a.name === 'stand')) $('spine-animation').value = 'stand'
      skinProfiles = createSkinCombinations(entry.json, entry.id)
      $('spine-skin').replaceChildren(...skinProfiles.map((profile, index) => option(String(index), profile.name)))
      $('spine-skin').value = '0'; $('spine-skin-options').open = false; applySkinProfile()
      canvas.hidden = false; $('spine-placeholder').hidden = true
      resetAnimation(); loading = false; busy(false); list()
      const partCount = resource.rig.skins.filter((item) => item.name !== 'default').length
      state(`${entry.name} · ${resource.rig.animations.length} 个动画片段 · ${partCount} 个部件`)
    } catch (error) {
      if (token !== generation || !active) return
      renderer?.dispose(); renderer = null; resource = null
      canvas.hidden = true; $('spine-placeholder').hidden = false
      loading = false; busy(false); state('读取失败：' + error.message, true)
    }
  }
  async function videoService() {
    if (!onServer) { $('spine-export-hint').textContent = '视频导出请用单文件程序打开；网页可本地预览。'; return }
    try {
      const response = await fetch('/__video/capabilities')
      const result = await response.json()
      if (!response.ok) throw Error(result.error)
      capabilities = result
      for (const option of $('spine-format').options) option.disabled = !result.formats.includes(option.value)
      if (!result.formats.includes($('spine-format').value)) $('spine-format').value = result.formats[0]
      $('spine-export-hint').textContent = '按设定帧率逐帧编码，最长 120 秒。'
    } catch (error) { $('spine-export-hint').textContent = error.message }
    if (!exporting) busy(false)
  }
  async function enter() {
    active = true
    if (!capabilities) void videoService()
    if (catalog) { list(); busy(false); if (resource) render(); return }
    if (!files?.spineBundles.length) { state('当前文件夹没有动画资源，请加载完整 StreamingAssets 或 SpineAnim / SpineAnimEn / SpineAnimEv / Fatal 文件夹。'); return }
    const token = ++generation
    loading = true; busy(true)
    try {
      const result = await readSpineCatalog(files, state, () => token !== generation || !active)
      if (!result || token !== generation || !active) return
      catalog = result; list()
      state(`当前显示 ${result.entries.length} 份骨骼动画${result.errors.length ? `，${result.errors.length} 个资源包读取失败：${result.errors[0].error}` : ''}。请选择资源。`, !!result.errors.length)
    } catch (error) { if (token === generation && active) state(error.message, true) }
    finally { if (token === generation) { loading = false; busy(false) } }
  }
  async function request(url, body, signal) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || '视频服务出错')
    return result
  }
  async function exportVideo() {
    if (!resource || !selected || exporting || !capabilities?.available) return
    let plan
    try {
      const [width, height] = $('spine-resolution').value.split('x').map(Number)
      plan = exportPlan({ width, height, fps: Number($('spine-fps').value), speed: Number($('spine-speed').value), start: Number($('spine-start').value), duration: Number($('spine-duration').value), loop: $('spine-loop').checked })
    } catch (error) { state(error.message, true); return }
    stop()
    const run = { cancelled: false, abort: new AbortController(), id: null }
    exporting = run; busy(true); list()
    const anim = animation()?.name, animLength = length(), skinName = skin(), background = $('spine-background').value, view = { ...camera }
    $('spine-download').hidden = true
    $('spine-export-progress').hidden = false
    $('spine-export-progress').value = 0
    let success = false
    try {
      const job = await request('/__video/create', { width: plan.width, height: plan.height, fps: plan.fps, frames: plan.frames, format: $('spine-format').value })
      run.id = job.id
      for (let i = 0; i < plan.frames; i++) {
        if (run.cancelled) throw Error('已取消导出')
        renderer.render(samplePose(resource.rig, anim, sourceTime(plan, i, animLength), skinName), view, plan.width, plan.height, background)
        const response = await fetch(`/__video/${job.id}/frame?index=${i}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: renderer.pixels(), signal: run.abort.signal })
        if (!response.ok) throw Error((await response.json()).error)
        $('spine-export-progress').value = (i + 1) / plan.frames
        state(`渲染视频 ${i + 1} / ${plan.frames} 帧`)
      }
      if (run.cancelled) throw Error('已取消导出')
      state('画面已渲染，正在完成视频编码…')
      const result = await request(`/__video/${job.id}/finish`, {}, run.abort.signal)
      if (run.cancelled) throw Error('已取消导出')
      $('spine-download').href = result.url
      $('spine-download').download = `${selected.name}_${anim || 'setup'}.${$('spine-format').value}`
      $('spine-download').textContent = `保存视频 · ${result.duration.toFixed(2)} 秒`
      $('spine-download').hidden = false
      success = true
      state(`视频已完成：${result.frames} 帧，${plan.fps} 帧 / 秒。点击保存视频。`)
    } catch (error) { if (active) state(run.cancelled ? '已取消导出。' : '导出失败：' + error.message, !run.cancelled) }
    finally {
      if (!success && run.id) await request(`/__video/${run.id}/cancel`).catch(() => {})
      exporting = null
      $('spine-export-progress').hidden = true
      busy(false)
      if (active) { list(); render() }
    }
  }
  function cancel() { if (exporting) { exporting.cancelled = true; exporting.abort.abort() } }
  function clearResource() {
    generation++; loading = false; stop(); drag = null
    renderer?.dispose(); renderer = null; resource = null; selected = null; camera = null
    canvas.hidden = true; $('spine-placeholder').hidden = false
    $('spine-animation').replaceChildren(); $('spine-skin').replaceChildren()
    skinProfiles = []; skinSelection = []; $('spine-skin-parts').replaceChildren()
    $('spine-skin-options').hidden = true; $('spine-skin-options').open = false; $('spine-skin-hint').textContent = ''
    $('spine-time').textContent = '0.00 / 0.00 秒'
    $('spine-seek').value = 0
    $('spine-download').hidden = true; $('spine-download').removeAttribute('href'); $('spine-download').removeAttribute('download')
    busy(false)
  }
  $('spine-export-video').addEventListener('click', () => void exportVideo())
  $('spine-cancel').addEventListener('click', cancel)
  $('spine-group').addEventListener('change', () => catalog && list())
  $('spine-search').addEventListener('input', () => catalog && list())
  $('spine-animation').addEventListener('change', resetAnimation)
  $('spine-skin').addEventListener('change', () => { applySkinProfile(); fit() })
  $('spine-fit').addEventListener('click', fit)
  $('spine-background').addEventListener('input', () => render())
  $('spine-seek').addEventListener('input', () => { stop(); render() })
  $('spine-play').addEventListener('click', () => {
    if (playing) return stop()
    if (!resource) return
    playing = true; $('spine-play').textContent = '暂停'; lastTick = performance.now()
    function tick(now) {
      if (!playing || !active) return
      let time = Number($('spine-seek').value) + (now - lastTick) / 1000 * (Number($('spine-speed').value) || 1)
      lastTick = now
      if (length() > 0 && time >= length()) { if ($('spine-loop').checked) time %= length(); else { time = length(); stop() } }
      try { render(time) } catch (error) { stop(); state(error.message, true) }
      if (playing) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
  let drag
  canvas.addEventListener('wheel', (event) => {
    if (!camera || exporting) return
    event.preventDefault(); camera.height = Math.max(1, Math.min(100000, camera.height * Math.exp(event.deltaY * 0.001))); render()
  }, { passive: false })
  canvas.addEventListener('pointerdown', (event) => {
    if (!camera || exporting) return
    drag = { x: event.clientX, y: event.clientY, camera: { ...camera } }; canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || exporting) return
    const unit = drag.camera.height / canvas.getBoundingClientRect().height
    camera.x = drag.camera.x - (event.clientX - drag.x) * unit; camera.y = drag.camera.y + (event.clientY - drag.y) * unit; render()
  })
  canvas.addEventListener('pointerup', () => { drag = null })
  canvas.addEventListener('pointercancel', () => { drag = null })
  canvas.addEventListener('dblclick', () => { if (!exporting) fit() })
  return {
    enter,
    hide() { active = false; generation++; loading = false; stop(); cancel(); busy(false) },
    setFiles(next) {
      active = false; generation++; loading = false; stop(); cancel()
      catalog = null; files = next
      clearResource(); $('spine-list').replaceChildren()
      for (const option of $('spine-group').options) option.disabled = false
    },
  }
}
