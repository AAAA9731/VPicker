import { getEmotInfo } from './pxl/person'
/** EvPerson.RegPicDirAndAM：`dir/aXX__表情` */
const RegPicDirAndAM = /^([^/]+\/)(a(?:(?!__)[a-zA-Z0-9_])+)__/
/** 生成 F7 面板给出的 PIC 指令：`PIC   n a_3/a2__F1__f3__m1__b1_uo    `（N 为 pic_replacing 标志） */
export function buildPic(personKey, pose, emotion, replacing = false) {
  return 'PIC   ' + personKey + ' ' + pose.name + '__' + emotion + '    ' + (replacing ? 'N' : '')
}
/** 解析一行 cmd 脚本里的 PIC 指令；不是 PIC 立绘指令（或使用 &N/#N 全屏图）则返回 null。 */
export function parsePicLine(line) {
  const t = line
    .replace(/\/\/.*$/, '')
    .trim()
    .split(/[ \t]+/)
  if (t.length < 3) return null
  if (t[0] !== 'PIC' && t[0] !== 'PIC_B' && t[0] !== 'PIC_R') return null
  if (t[1].startsWith('&') || t[1].startsWith('#')) return null
  return { cmd: t[0], person: t[1], identifier: t[2], rest: t.slice(3).join(' ') }
}
/** 反向：由 `姿势__表情` 定位到 vp 面板中的姿势与表情（EvDebugger.executeLiRCommand 的逻辑）。 */
export function locatePic(person, identifier) {
  const m = RegPicDirAndAM.exec(identifier)
  if (!m) return null
  const poseName = m[1] + m[2]
  const emotion = identifier.slice(m[0].length)
  let pose = null
  for (let i = person.poses.length - 1; i >= 0; i--) {
    if (person.poses[i].name === poseName) {
      pose = person.poses[i]
      break
    }
  }
  if (!pose) return null
  return { pose, emotion, emotionFound: getEmotInfo(pose, emotion) !== null }
}
