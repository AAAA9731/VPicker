import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpinePanel } from '../src/spine'

// 用最小 DOM 验证阅读门槛；不依赖游戏素材或浏览器。
describe('Spine 使用须知', () => {
  let doc, elements, panel
  const click = (id) => elements[id].dispatchEvent(new Event('click'))
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
    elements = Object.fromEntries([
      'spine', 'spine-notice', 'spine-notice-confirm',
      'spine-notice-title', 'spine-title', 'spine-read-notice',
      'spine-format', 'spine-resolution', 'spine-fps', 'spine-export-summary',
    ].map((id) => [id, Object.assign(new EventTarget(), { focus: vi.fn() })]))
    const notice = elements['spine-notice']
    notice.open = false
    notice.showModal = () => { notice.open = true }
    notice.close = () => { notice.open = false }
    doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible', getElementById: (id) => elements[id],
    })
    vi.stubGlobal('document', doc)
    panel = createSpinePanel()
  })
  afterEach(() => {
    panel.hide()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('阅读满 3 秒前不能进入，满 3 秒仍需主动确认', () => {
    panel.open()
    expect(elements['spine-notice'].open).toBe(true)
    expect(elements.spine.hidden).toBe(true)
    expect(elements['spine-notice-confirm'].textContent).toContain('3 秒')
    vi.advanceTimersByTime(2999)
    expect(elements['spine-notice-confirm'].disabled).toBe(true)
    expect(elements['spine-notice-confirm'].textContent).toContain('1 秒')
    click('spine-notice-confirm')
    expect(elements['spine-notice'].open).toBe(true)
    vi.advanceTimersByTime(1)
    expect(elements['spine-notice-confirm'].disabled).toBe(false)
    expect(elements.spine.hidden).toBe(true)
    click('spine-notice-confirm')
    expect(elements['spine-notice'].open).toBe(false)
    expect(elements.spine.hidden).toBe(false)
  })

  it('每次重新进入都必须重新阅读，Escape 不能跳过', () => {
    panel.open()
    vi.advanceTimersByTime(3000)
    click('spine-notice-confirm')
    panel.hide()
    panel.open()
    expect(elements['spine-notice-confirm'].disabled).toBe(true)
    expect(elements['spine-notice-confirm'].textContent).toContain('3 秒')
    const cancel = new Event('cancel', { cancelable: true })
    elements['spine-notice'].dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(elements.spine.hidden).toBe(true)
  })

  it('后台时间不计入阅读时长', () => {
    panel.open()
    vi.advanceTimersByTime(1000)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(10000)
    expect(elements['spine-notice-confirm'].disabled).toBe(true)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1999)
    expect(elements['spine-notice-confirm'].disabled).toBe(true)
    vi.advanceTimersByTime(1)
    expect(elements['spine-notice-confirm'].disabled).toBe(false)
  })

  it('关闭面板清理计时，查看须知也重新计时', () => {
    panel.open()
    panel.hide()
    expect(vi.getTimerCount()).toBe(0)
    expect(elements['spine-notice'].open).toBe(false)
    panel.open()
    vi.advanceTimersByTime(3000)
    click('spine-notice-confirm')
    click('spine-read-notice')
    expect(elements['spine-notice-confirm'].disabled).toBe(true)
    expect(elements.spine.hidden).toBe(true)
  })
})
