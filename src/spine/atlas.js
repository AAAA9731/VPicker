// Independent Spine 4.1 .atlas parser.
//
// Written from scratch against the public Spine atlas format description and the
// input data itself (83 JSON skeletons / 57 atlases under build/spine-export).
// No Spine Runtime source, port or translated code was consulted.
//
// Region geometry semantics used here, derived from the input data (see
// src/spine/INDEPENDENT.md for the derivation and the residual uncertainties):
//
//   pageName.png
//   size: <pageWidth>,<pageHeight>
//   filter: <min>,<mag>
//   repeat: none|X|Y|XY
//   pma: true|false                     (optional, default false)
//   scale: <s>                          (optional, default 1)
//   <regionName>
//   bounds: <x>,<y>,<width>,<height>    packed rect top-left on the page
//   offsets: <ox>,<oy>,<origW>,<origH>  (optional) ox/oy: position of the packed
//                                       (unrotated) region inside the original
//                                       image, page pixels, y from the bottom;
//                                       origW/origH: original image size, page px
//   rotate: 0|90|180|270                (optional, default 0)
//   index: <n>                          (optional)
//
// `bounds` width/height are the region's *unrotated* (logical) size. For
// rotate 90/270 the footprint actually occupied on the page is height x width
// starting at (x, y). `rotate: N` means the stored (packed) content is the
// logical image rotated N degrees counter-clockwise; rotating it back requires
// a clockwise rotation. Verified against 2167 regions: the "bounds is logical"
// reading keeps every region inside its page (0 violations) while the
// "bounds is footprint" reading overflows 170 times.

const PAGE_KEYS = new Set(['size', 'filter', 'repeat', 'pma', 'scale']);
const REGION_KEYS = new Set(['bounds', 'offsets', 'rotate', 'index']);

function fail(file, line, why) {
  throw new Error(`atlas${file ? ` (${file})` : ''}: ${why}: ${line}`);
}

/**
 * Parse atlas text.
 * @param {string} text
 * @param {{file?: string}} [opts]
 * @returns {{pages: Array<{name:string,width:number,height:number,pma:boolean,filter?:string,repeat?:string,scale:number}>,
 *            regions: Map<string, object>}}
 */
export function parseAtlas(text, opts = {}) {
  const file = opts.file;
  if (typeof text !== 'string') throw new TypeError('parseAtlas expects atlas text');
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line.length !== 0) lines.push(line);
  }

  const pages = [];
  const regions = new Map();
  const duplicates = [];
  let page = null;
  let region = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : null;
    const value = colon > 0 ? line.slice(colon + 1).trim() : null;

    if (key === null) {
      // A bare line is either a page image name (always followed by `size:`) or a region name.
      const next = lines[i + 1];
      if (next && next.startsWith('size:')) {
        page = { name: line, width: 0, height: 0, pma: false, scale: 1, regions: [] };
        pages.push(page);
        region = null;
      } else {
        if (page === null) fail(file, line, 'region outside of any page');
        region = { name: line, page: page.name, rotate: 0, index: 0, _page: page };
        page.regions.push(region);
        if (regions.has(line)) duplicates.push(line);
        else regions.set(line, region);
      }
      continue;
    }

    if (region === null || PAGE_KEYS.has(key)) {
      if (!PAGE_KEYS.has(key)) fail(file, line, 'page directive before any page');
      if (page === null) fail(file, line, 'page directive before any page');
      switch (key) {
        case 'size': {
          const parts = value.split(',').map(Number);
          if (parts.length !== 2 || !parts.every(Number.isFinite)) fail(file, line, 'bad size');
          page.width = parts[0];
          page.height = parts[1];
          break;
        }
        case 'filter':
          page.filter = value;
          break;
        case 'repeat':
          page.repeat = value;
          break;
        case 'pma':
          page.pma = value === 'true';
          break;
        case 'scale': {
          const s = Number(value);
          if (!Number.isFinite(s) || s <= 0) fail(file, line, 'bad scale');
          page.scale = s;
          break;
        }
        default:
          fail(file, line, 'unknown page directive');
      }
      continue;
    }

    if (!REGION_KEYS.has(key)) fail(file, line, 'unknown region directive');

    switch (key) {
      case 'bounds': {
        const parts = value.split(',').map(Number);
        if (parts.length !== 4 || !parts.every(Number.isFinite)) fail(file, line, 'bad bounds');
        region.x = parts[0];
        region.y = parts[1];
        region.width = parts[2];
        region.height = parts[3];
        break;
      }
      case 'offsets': {
        const parts = value.split(',').map(Number);
        if (parts.length !== 4 || !parts.every(Number.isFinite)) fail(file, line, 'bad offsets');
        region.offsetsRaw = parts;
        break;
      }
      case 'rotate': {
        const r = Number(value);
        if (r !== 0 && r !== 90 && r !== 180 && r !== 270) fail(file, line, 'rotate must be 0/90/180/270');
        region.rotate = r;
        break;
      }
      case 'index':
        region.index = Number(value);
        break;
      default:
        fail(file, line, 'unknown region directive');
    }
  }

  for (const p of pages) {
    if (!p.width || !p.height) throw new Error(`atlas${file ? ` (${file})` : ''}: page ${p.name} has no size`);
    for (const r of p.regions) finalizeRegion(r, p);
  }

  return { pages, regions, duplicates };
}

function finalizeRegion(region, page) {
  if (region.width === undefined) throw new Error(`atlas: region ${region.name} has no bounds`);
  const scale = (region._page && region._page.scale) || 1;
  delete region._page;
  region.scale = scale;
  region.pma = page.pma;

  // Page footprint: rotate 90/270 swap width/height.
  const swapped = region.rotate === 90 || region.rotate === 270;
  region.footprintWidth = swapped ? region.height : region.width;
  region.footprintHeight = swapped ? region.width : region.height;

  if (region.offsetsRaw) {
    const [ox, oy, ow, oh] = region.offsetsRaw;
    region.offsetX = ox / scale;
    region.offsetY = oy / scale;
    region.originalWidth = ow / scale;
    region.originalHeight = oh / scale;
  } else {
    region.offsetX = 0;
    region.offsetY = 0;
    region.originalWidth = region.width / scale;
    region.originalHeight = region.height / scale;
  }

  // Normalized texture rectangle of the packed region (top-left origin, as the
  // renderer wants its UVs). u0/v0 is the top-left corner of the page rect. For
  // rotate 90/270 the rect actually occupied on the page is the swapped
  // footprint (height x width), so u1/v1 use the footprint, not the unrotated
  // `bounds` size.
  const pw = page.width;
  const ph = page.height;
  region.uv = {
    u0: region.x / pw,
    v0: region.y / ph,
    u1: (region.x + region.footprintWidth) / pw,
    v1: (region.y + region.footprintHeight) / ph,
  };
  region.pageWidth = pw;
  region.pageHeight = ph;
}

/**
 * Map trimmed-region coordinates to normalized texture coordinates.
 *
 * (u, v) are in the *trimmed* (packed) region's own frame: u grows right from
 * the trim rect's left edge, v grows *up* from its bottom edge, both normalized
 * by the trimmed size, so (0,0) is the trimmed bottom-left and (1,1) the
 * trimmed top-right. Values outside [0, 1] are accepted and never clamped.
 * Region quads cover exactly the trimmed rect and use this contract directly.
 *
 * This is NOT the space of mesh `uvs` in the Spine JSON: those are normalized
 * over the *original* (untrimmed) image with a TOP-left origin, so v grows
 * down. Mesh UVs must first be converted to trimmed-region coordinates (see
 * mapMeshUvs in pose.js) and only then passed here.
 *
 * Returns [texU, texV] with the top-left texture origin used by WebGL-style
 * texture uploads.
 */
export function regionUvAt(region, u, v) {
  const w = region.width;
  const h = region.height;
  const x = region.x;
  const y = region.y;
  let px;
  let py;
  switch (region.rotate) {
    case 0:
      px = x + u * w;
      py = y + (1 - v) * h;
      break;
    case 90:
      px = x + (1 - v) * h;
      py = y + (1 - u) * w;
      break;
    case 180:
      px = x + (1 - u) * w;
      py = y + v * h;
      break;
    case 270:
      px = x + v * h;
      py = y + u * w;
      break;
    default:
      throw new Error(`atlas: unsupported rotate ${region.rotate} for ${region.name}`);
  }
  return [px / region.pageWidth, py / region.pageHeight];
}

export default { parseAtlas, regionUvAt };
