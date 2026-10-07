/** Spine 前端面板。每次进入重新计时，不持久化须知确认状态。 */
export function createSpinePanel({ onEnter = () => {}, onHide = () => {} } = {}) {
  const $ = (id) => document.getElementById(id)
  const root = $('spine')
  const notice = $('spine-notice')
  const confirm = $('spine-notice-confirm')
  let interval = null
  let elapsed = 0
  let lastTick = 0
  let visible = false
  let ready = false

  function stopTimer() {
    clearInterval(interval)
    interval = null
  }
  function tick() {
    const now = performance.now()
    if (visible) elapsed += now - lastTick
    lastTick = now
    visible = document.visibilityState === 'visible'
    ready = elapsed >= 3000
    const seconds = Math.max(0, Math.ceil((3000 - elapsed) / 1000))
    confirm.disabled = !ready
    confirm.textContent = ready ? '我已阅读并理解，进入功能' : `阅读中（${seconds} 秒）`
    if (ready) stopTimer()
  }
  function open() {
    onHide()
    stopTimer()
    root.hidden = true
    elapsed = 0
    ready = false
    lastTick = performance.now()
    visible = document.visibilityState === 'visible'
    confirm.disabled = true
    confirm.textContent = '阅读中（3 秒）'
    if (!notice.open) notice.showModal()
    $('spine-notice-title').focus()
    interval = setInterval(tick, 100)
  }
  function hide() {
    onHide()
    stopTimer()
    ready = false
    root.hidden = true
    if (notice.open) notice.close()
  }

  // Escape 不能跳过阅读或确认；切换到后台的时间不计入阅读时长。
  notice.addEventListener('cancel', (e) => e.preventDefault())
  document.addEventListener('visibilitychange', () => {
    if (notice.open && !ready) tick()
  })
  confirm.addEventListener('click', () => {
    if (!ready) return
    stopTimer()
    notice.close()
    root.hidden = false
    $('spine-title').focus()
    onEnter()
  })
  $('spine-read-notice').addEventListener('click', open)

  function updateSummary() {
    const resolution = $('spine-resolution').selectedOptions[0].textContent
    const format = $('spine-format').value.toUpperCase()
    $('spine-export-summary').textContent = `${resolution} · ${$('spine-fps').value} 帧 / 秒 · ${format}`
  }
  for (const id of ['spine-format', 'spine-resolution', 'spine-fps']) {
    $(id).addEventListener('change', updateSummary)
  }

  return { open, hide }
}
