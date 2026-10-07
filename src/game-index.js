export const PXL_FILES = /^(.+\.pxls\.dat|.+\.pxls\.bytes\.texture_\d+\.dat|__vp_person\.dat)$/
export const SKIP_GAME_DIRS = new Set(['Managed', 'MonoBleedingEdge', 'BepInEx', 'Resources', 'Plugins', 'Il2CppData'])
export const SPINE_DIRS = new Set(['SpineAnim', 'SpineAnimEn', 'SpineAnimEv', 'Fatal'])
/** Keep the group in the key: bundles from different groups can have identical names. */
export function spineFileKey(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  const group = parts.findLast((part) => SPINE_DIRS.has(part))
  const name = parts.at(-1)
  return group && name?.endsWith('.dat') ? `${group}/${name}` : null
}
