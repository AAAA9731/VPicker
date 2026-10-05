export function parsePersonDef(text) {
  const out = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    const t = line.split(/[ \t　]+/)
    if (t[0] === '%PXL_PERSON') {
      if (cur && t[1]) out.push({ key: cur.key, name: cur.name, pxl: t[1] })
    } else if (!t[0].startsWith('%')) {
      cur = { key: t[0], name: t[1] ?? '' }
    }
  }
  return out
}
/** 没有 __vp_person.dat 时的退路：按文件名猜角色 key（__ev_n → n，__ev_n_bass → 用全名）。 */
export function guessPersonsFromFiles(pxlNames) {
  return pxlNames.filter((n) => n.startsWith('__ev_')).map((n) => ({ key: n.slice(5), name: '', pxl: n }))
}
