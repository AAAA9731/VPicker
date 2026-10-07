import gamePresets from './skin-presets.json' with { type: 'json' }

const TITLES = { cloth: '服装', arm: '手臂', Rarm: '右臂', Larm: '左臂', Narm: '手臂', face: '表情', f: '表情', leg: '腿部', foot: '腿部', bust: '上身', main: '主体', lowhp: '状态' }

function family(name) {
  if (name === 'lowhp' || name === 'no_lowhp') return 'lowhp'
  if (name.includes('/')) return name.slice(0, name.lastIndexOf('/'))
  if (/^cloth(?:_|[A-Z])/.test(name)) return 'cloth'
  return name.match(/^(.*?)(?:_|(?=\d))/)?.[1] || name
}

function attachmentKeys(skin) {
  return new Set(Object.entries(skin?.attachments || {}).flatMap(([slot, attachments]) => Object.keys(attachments).map((name) => `${slot}/${name}`)))
}

/** Build combined skins, not standalone component previews. Game presets hold
 * only skin-selection names derived from game configuration, no game code or
 * images. Unconfigured resources use setup-attachment coverage as a fallback;
 * this is an inference, not a claim to reproduce scripted scene states. */
export function createSkinCombinations(json, resourceId) {
  const skins = json.skins || [], known = new Set(skins.map((skin) => skin.name))
  const base = known.has('default') ? ['default'] : skins.length ? [skins[0].name] : []
  const baseKeys = attachmentKeys(skins.find((skin) => skin.name === base[0]))
  const required = new Set((json.slots || []).filter((slot) => slot.attachment).map((slot) => `${slot.name}/${slot.attachment}`).filter((key) => !baseKeys.has(key)))
  const keysBySkin = new Map(skins.map((skin) => [skin.name, attachmentKeys(skin)]))
  const definitions = gamePresets[resourceId] || [{ name: '自动组合', groups: [] }]
  const seen = new Set(), profiles = []
  for (const definition of definitions) {
    const groups = definition.groups.map((group) => ({ ...group, names: group.names.filter((name) => known.has(name) && !base.includes(name)) }))
      .filter((group) => group.names.length)
    const assigned = new Set(groups.flatMap((group) => group.names))
    for (const name of known) {
      if (base.includes(name) || assigned.has(name)) continue
      const key = family(name)
      let group = groups.find((group) => group.names.every((member) => family(member) === key))
      if (!group) { group = { id: `part:${key}`, names: [], initial: '' }; groups.push(group) }
      group.names.push(name); assigned.add(name)
    }
    const configured = !!gamePresets[resourceId]
    for (const group of groups) {
      if (!group.names.includes(group.initial)) group.initial = ''
      if (!configured) {
        let best = 0
        for (const name of group.names) {
          const coverage = [...keysBySkin.get(name)].filter((key) => required.has(key)).length
          if (coverage > best) { best = coverage; group.initial = name }
        }
      }
      const families = [...new Set(group.names.map(family))]
      group.title = families.length === 1 ? (TITLES[families[0]] || families[0]) : group.id === '0' ? '主体部件' : `叠加部件 ${group.id}`
    }
    const signature = JSON.stringify(groups.map((group) => [group.names, group.initial]))
    if (seen.has(signature)) continue
    seen.add(signature)
    profiles.push({ name: configured ? `游戏配置 · ${definition.name}` : groups.length ? '自动组合' : '默认组合', base, groups, configured })
  }
  return profiles
}
