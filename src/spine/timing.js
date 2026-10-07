export function exportPlan({ width, height, fps, speed, start, duration, loop }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !['1280x720', '1920x1080', '2560x1440'].includes(`${width}x${height}`) || ![24, 30, 60].includes(fps)) throw Error('分辨率或帧率无效')
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) throw Error('播放速率须为 0.1 至 10')
  if (!Number.isFinite(start) || start < 0 || start > 3600) throw Error('起始动画时间须为 0 至 3600 秒')
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw Error('视频时长须在 0 至 120 秒内')
  return { width, height, fps, speed, start, duration, loop: !!loop, frames: Math.ceil(duration * fps) }
}
export function sourceTime(plan, frame, animationDuration) {
  const time = plan.start + frame * plan.speed / plan.fps
  return animationDuration > 0 ? (plan.loop ? time % animationDuration : Math.min(time, animationDuration)) : 0
}
