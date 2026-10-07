import { readBundleAssets } from './unity/serialized'
import { decodeTexture, initDecoder } from './unity/texture'
import { readPxl } from './pxl/reader'
import { buildPerson } from './pxl/person'
import { guessPersonsFromFiles, parsePersonDef } from './persons'
import { AtlasStore } from './render'
import { PXL_FILES as WANTED, SKIP_GAME_DIRS as SKIP_DIR, SPINE_DIRS, spineFileKey } from './game-index'
/** SimplePatch 的 PicLoad 补丁读取自定义 PNG 的文件夹（StreamingAssets 下） */
const PIC_DIR = 'SimplePatch_pic'
const isPng = (n) => /\.png$/i.test(n)
/** 用户选中的文件夹里与立绘相关的文件索引（按文件名，不分目录）。 */
export class GameFiles {
  files = new Map()
  /** 是否找到 SimplePatch_pic 文件夹，以及里面的 PNG（相对该文件夹的路径 → 取文件） */
  picDir = false
  /** 是否能往 SimplePatch_pic 写文件（导入 / 重命名）：只有 exe 自带服务器按路径加载时为 true */
  writable = false
  pics = new Map()
  defs = []
  /** 非立绘的图片包（事件 CG、UI、小游戏素材等），key 即包名 */
  others = []
  spineBundles = []
  has(name) {
    return this.files.has(name)
  }
  async read(name) {
    const g = this.files.get(name)
    if (!g) throw new Error('缺少文件 ' + name)
    return new Uint8Array(await (await g()).arrayBuffer())
  }
  async addFileList(list) {
    for (const f of Array.from(list)) {
      if (WANTED.test(f.name)) this.files.set(f.name, async () => f)
      const spineKey = spineFileKey(f.webkitRelativePath || f.name)
      if (spineKey) this.files.set(spineKey, async () => f)
      const segs = (f.webkitRelativePath || '').split('/')
      const at = segs.indexOf(PIC_DIR)
      if (at >= 0 && at < segs.length - 1) {
        this.picDir = true
        if (isPng(f.name)) this.pics.set(segs.slice(at + 1).join('/'), async () => f)
      }
    }
  }
  /** picRel：位于 SimplePatch_pic 内时，当前目录相对它的路径（根为 ''）；否则为 null。 */
  async addDirHandle(dir, depth = 0, picRel = null, spineGroup = null) {
    if (SPINE_DIRS.has(dir.name)) spineGroup = dir.name
    if (picRel === null && dir.name === PIC_DIR) {
      this.picDir = true
      picRel = ''
    }
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') {
        if (picRel !== null) {
          if (depth < 8) await this.addDirHandle(h, depth + 1, picRel + name + '/')
        } else if (name === PIC_DIR) {
          this.picDir = true
          await this.addDirHandle(h, depth + 1, '')
        } else if (depth < 8 && !SKIP_DIR.has(name)) await this.addDirHandle(h, depth + 1, null, spineGroup)
      } else if (picRel !== null) {
        if (isPng(name)) this.pics.set(picRel + name, () => h.getFile())
      } else if (WANTED.test(name)) {
        this.files.set(name, () => h.getFile())
      } else if (spineGroup && name.endsWith('.dat')) {
        this.files.set(`${spineGroup}/${name}`, () => h.getFile())
      }
    }
  }
  /** picRel 同 addDirHandle；entry 是 SimplePatch_pic 自身时按根处理。 */
  async addEntry(entry, depth = 0, picRel = null, spineGroup = null) {
    if (entry.isFile) {
      if (picRel !== null) {
        if (isPng(entry.name)) this.pics.set(picRel + entry.name, () => new Promise((res, rej) => entry.file(res, rej)))
      } else if (WANTED.test(entry.name)) {
        this.files.set(entry.name, () => new Promise((res, rej) => entry.file(res, rej)))
      } else if (spineGroup && entry.name.endsWith('.dat')) {
        this.files.set(`${spineGroup}/${entry.name}`, () => new Promise((res, rej) => entry.file(res, rej)))
      }
      return
    }
    if (!entry.isDirectory || depth >= 8) return
    if (SPINE_DIRS.has(entry.name)) spineGroup = entry.name
    let childRel = null
    if (picRel !== null) childRel = picRel + entry.name + '/'
    else if (entry.name === PIC_DIR) {
      this.picDir = true
      childRel = ''
    } else if (SKIP_DIR.has(entry.name)) return
    const reader = entry.createReader()
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const e of batch) await this.addEntry(e, depth + 1, childRel, spineGroup)
    }
  }
  /** 选择完成后调用：解析角色表。 */
  async finish() {
    this.spineBundles = [...this.files.keys()].filter((n) => spineFileKey(n) && n.endsWith('.atlas.dat')).sort()
    const pxlNames = [...this.files.keys()].filter((n) => n.endsWith('.pxls.dat')).map((n) => n.slice(0, -'.pxls.dat'.length))
    let defs = []
    if (this.files.has('__vp_person.dat')) {
      defs = parsePersonDef(new TextDecoder().decode(await this.read('__vp_person.dat')))
    }
    const known = new Set(defs.map((d) => d.pxl))
    // __vp_person.dat 里没有登记、但文件存在的立绘包，补充一个猜测的角色 key
    for (const g of guessPersonsFromFiles(pxlNames)) if (!known.has(g.pxl)) defs.push(g)
    this.defs = defs.filter((d) => this.files.has(d.pxl + '.pxls.dat'))
    const used = new Set(this.defs.map((d) => d.pxl))
    this.others = pxlNames
      .filter((n) => !n.startsWith('__ev_') && !used.has(n))
      .sort()
      .map((n) => ({ key: n, name: '', pxl: n }))
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
