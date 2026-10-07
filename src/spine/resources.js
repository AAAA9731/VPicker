import { readBundleAssets } from '../unity/serialized'
import { initDecoder, decodeTexture } from '../unity/texture'
import { parseAtlas } from './atlas'
import { createRig } from './pose'

const decoder = new TextDecoder()
const yieldUI = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Read-only local input. Skeleton and texture data never become download links. */
export async function readSpineCatalog(files, progress, cancelled = () => false) {
  const entries = [], errors = []
  for (const [index, bundle] of files.spineBundles.entries()) {
    if (cancelled()) return null
    progress?.(`读取动画目录 ${index + 1} / ${files.spineBundles.length}`)
    await yieldUI()
    try {
      const { texts } = readBundleAssets(await files.read(bundle))
      const atlasText = texts.find((text) => text.name.endsWith('.atlas'))
      if (!atlasText) throw Error('缺少 atlas 描述')
      const atlas = parseAtlas(decoder.decode(atlasText.bytes))
      for (const text of texts) {
        if (text === atlasText) continue
        const data = JSON.parse(decoder.decode(text.bytes))
        if (!data.skeleton || !Array.isArray(data.bones)) continue
        entries.push({ id: `${bundle}/${text.name}`, name: text.name, group: bundle.split('/')[0], bundle, json: data, atlas })
      }
    } catch (error) { errors.push({ bundle, error: error.message }) }
  }
  return { entries, errors }
}
export async function loadSpineResource(files, entry, wasmPath) {
  const textureBundle = entry.bundle.replace(/\.atlas\.dat$/, '.dat')
  if (!files.has(textureBundle)) throw Error('缺少贴图资源包 ' + textureBundle)
  const { textures } = readBundleAssets(await files.read(textureBundle))
  await initDecoder(wasmPath)
  const pages = new Map()
  for (const page of entry.atlas.pages) {
    const base = page.name.replace(/\.[^.]+$/, '')
    const texture = textures.find((texture) => texture.name === base || texture.name === page.name)
    if (!texture) throw Error('缺少贴图页 ' + page.name)
    const pixels = await decodeTexture(texture)
    if (pixels.width !== page.width || pixels.height !== page.height) throw Error('贴图尺寸与 atlas 不一致：' + page.name)
    pages.set(page.name, { ...pixels, pma: page.pma })
  }
  return { rig: createRig(entry.json, entry.atlas), pages }
}
