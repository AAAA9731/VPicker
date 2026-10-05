import { readBundleAssets } from './unity/serialized'
import { decodeTexture, initDecoder } from './unity/texture'
import { readPxl } from './pxl/reader'
import { buildPerson } from './pxl/person'
import { guessPersonsFromFiles, parsePersonDef } from './persons'
import { AtlasStore } from './render'
const WANTED = /^(__ev_.*\.pxls\.dat|__ev_.*\.pxls\.bytes\.texture_\d+\.dat|__vp_person\.dat)$/
const SKIP_DIR = new Set(['Managed', 'MonoBleedingEdge', 'BepInEx', 'Resources', 'Plugins', 'Il2CppData'])
/** 用户选中的文件夹里与立绘相关的文件索引（按文件名，不分目录）。 */
export class GameFiles {
  files = new Map()
  defs = []
  has(name) {
    return this.files.has(name)
  }
  async read(name) {
    const g = this.files.get(name)
    if (!g) throw new Error('缺少文件 ' + name)
    return new Uint8Array(await (await g()).arrayBuffer())
  }
  async addFileList(list) {
    for (const f of Array.from(list)) if (WANTED.test(f.name)) this.files.set(f.name, async () => f)
  }
  async addDirHandle(dir, depth = 0) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') {
        if (depth < 8 && !SKIP_DIR.has(name)) await this.addDirHandle(h, depth + 1)
      } else if (WANTED.test(name)) {
        this.files.set(name, () => h.getFile())
      }
    }
  }
  async addEntry(entry, depth = 0) {
    if (entry.isFile) {
      if (WANTED.test(entry.name)) this.files.set(entry.name, () => new Promise((res, rej) => entry.file(res, rej)))
    } else if (entry.isDirectory && depth < 8 && !SKIP_DIR.has(entry.name)) {
      const reader = entry.createReader()
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await this.addEntry(e, depth + 1)
      }
    }
  }
  /** 选择完成后调用：解析角色表。 */
  async finish() {
    const pxlNames = [...this.files.keys()].filter((n) => n.endsWith('.pxls.dat')).map((n) => n.slice(0, -'.pxls.dat'.length))
    let defs = []
    if (this.files.has('__vp_person.dat')) {
      defs = parsePersonDef(new TextDecoder().decode(await this.read('__vp_person.dat')))
    }
    const known = new Set(defs.map((d) => d.pxl))
    // __vp_person.dat 里没有登记、但文件存在的立绘包，补充一个猜测的角色 key
    for (const g of guessPersonsFromFiles(pxlNames)) if (!known.has(g.pxl)) defs.push(g)
    this.defs = defs.filter((d) => this.files.has(d.pxl + '.pxls.dat'))
  }
}
const paint = () => new Promise((r) => setTimeout(r, 16))
export async function loadPerson(gf, def, wasmPath, onProgress) {
  // 进度按步骤数估算：解析 PXL 占 1 步，每张图集 4 步（读包 / 解压 Crunch / 解码 / 转换）
  const steps = 1 + 4 * (gf.has(def.pxl + '.pxls.bytes.texture_0.dat') ? 1 : 0)
  let total = steps
  let done = 0
  const step = async (label) => {
    if (!onProgress) return
    onProgress(Math.min(done / total, 0.99), label)
    done++
    await paint()
  }
  await step('读取 PXL 数据')
  const { texts } = readBundleAssets(await gf.read(def.pxl + '.pxls.dat'))
  if (!texts.length) throw new Error(def.pxl + ' 中没有 PXL 数据')
  const chara = readPxl(def.pxl, texts[0].bytes)
  const person = buildPerson(def.key, chara)
  total = 1 + 4 * chara.atlases.filter((a) => !a.png).length
  const pixels = []
  await initDecoder(wasmPath)
  for (const a of chara.atlases) {
    if (a.png) {
      pixels.push(await createImageBitmap(new Blob([a.png], { type: 'image/png' })))
    } else {
      const name = `${def.pxl}.pxls.bytes.texture_${a.index}.dat`
      if (!gf.has(name)) {
        pixels.push(null)
        continue
      }
      await step('读取贴图资源包')
      const { textures } = readBundleAssets(await gf.read(name))
      pixels.push(textures.length ? await decodeTexture(textures[0], step) : null)
    }
  }
  onProgress?.(1, '完成')
  return { def, person, store: new AtlasStore(chara, pixels) }
}
