// Independent Spine 4.1 pose evaluator.
//
// Clean-room implementation: bone transform inheritance, weighted/unweighted
// meshes, region/sequence attachments, linked meshes, deform / draw-order /
// attachment / colour timelines and (absolute control point) cubic Bezier
// interpolation are derived from the public data format documentation and from
// the input data itself (build/spine-export). No Spine Runtime source code,
// port, translated code or dependency is used. See src/spine/INDEPENDENT.md.
//
// Public contract:
//   createRig(json, atlas) -> rig
//   samplePose(rig, animationName, sourceTime, skinName = 'default')
//     -> { draws: [{page, region, positions, uvs, indices, color, blend}],
//          bounds: {minX, minY, maxX, maxY} }
//   animationDuration(animationData) -> seconds
//
// A single animation is sampled over the setup pose at an explicit source time.
// There is no state, no AnimationState mixing, no looping and no events
// (the caller handles looping, speed and scripted behaviour).
//
// samplePose is synchronous and not re-entrant (it reuses per-rig scratch
// buffers); positions and colours are freshly allocated per call, while uvs and
// index buffers are shared immutable prepared data.

import { regionUvAt } from './atlas.js';

const DEG = Math.PI / 180;
const BLEND_MODES = new Set(['normal', 'additive', 'multiply', 'screen']);
const TRANSFORM_MODES = new Set(['normal', 'onlyTranslation', 'noScale', 'noScaleOrReflection', 'noRotationOrReflection']);

function fail(msg) {
  throw new Error(`spine: ${msg}`);
}

function hexToRgba(hex, out) {
  if (typeof hex !== 'string' || (hex.length !== 6 && hex.length !== 8)) {
    fail(`unsupported colour value "${hex}"`);
  }
  const v = parseInt(hex, 16);
  if (!Number.isFinite(v)) fail(`unsupported colour value "${hex}"`);
  if (hex.length === 6) {
    out[0] = ((v >> 16) & 255) / 255;
    out[1] = ((v >> 8) & 255) / 255;
    out[2] = (v & 255) / 255;
    out[3] = 1;
  } else {
    out[0] = ((v >>> 24) & 255) / 255;
    out[1] = ((v >>> 16) & 255) / 255;
    out[2] = ((v >>> 8) & 255) / 255;
    out[3] = (v & 255) / 255;
  }
  return out;
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function cubicAt(p0, p1, p2, p3, s) {
  const u = 1 - s;
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
}

function cubicDeriv(p0, p1, p2, p3, s) {
  const u = 1 - s;
  return 3 * u * u * (p1 - p0) + 6 * u * s * (p2 - p1) + 3 * s * s * (p3 - p2);
}

/**
 * Solve for the Bezier parameter s where the x polynomial equals `t`.
 * The data keeps the two control point times inside the segment, so x(s) is
 * monotonic; the fallback scan only runs if that is ever violated.
 */
function bezierSolve(t, t0, x1, x2, t1) {
  if (!(t1 > t0)) return 0;
  const x = (s) => cubicAt(t0, x1, x2, t1, s);
  let s = (t - t0) / (t1 - t0);
  for (let i = 0; i < 8; i++) {
    const f = x(s) - t;
    if (Math.abs(f) < 1e-10) return s;
    const d = cubicDeriv(t0, x1, x2, t1, s);
    if (Math.abs(d) < 1e-12) break;
    const next = s - f / d;
    if (!(next >= 0 && next <= 1)) break;
    s = next;
  }
  const f0 = x(0) - t;
  if (Math.abs(f0) < 1e-12) return 0;
  const f1 = x(1) - t;
  if (Math.abs(f1) < 1e-12) return 1;
  if ((f0 < 0) === (f1 < 0)) {
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i <= 200; i++) {
      const err = Math.abs(x(i / 200) - t);
      if (err < bestErr) {
        bestErr = err;
        best = i / 200;
      }
    }
    return best;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) * 0.5;
    const fm = x(mid) - t;
    if (Math.abs(fm) < 1e-12) return mid;
    if ((fm < 0) === (f0 < 0)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

// ---------------------------------------------------------------------------
// Numeric timelines
//
//   times    Float64Array(n)
//   values   Float64Array(n * comps)
//   segments Array(n - 1): null (linear) | {stepped:true} | Float64Array(comps*4)
//
// `curve` arrays carry *absolute* control point (time, value) pairs, one group
// of four per component (Spine 4.1 stores absolute control points).
// ---------------------------------------------------------------------------

function makeTimeline(keyframes, comps, readValues, name) {
  const n = keyframes.length;
  if (n === 0) return null;
  const times = new Float64Array(n);
  const values = new Float64Array(n * comps);
  const segments = new Array(n - 1);
  const tmp = new Array(comps);
  for (let i = 0; i < n; i++) {
    const kf = keyframes[i];
    times[i] = kf.time === undefined ? 0 : kf.time;
    readValues(kf, tmp);
    for (let c = 0; c < comps; c++) {
      const v = tmp[c];
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`non-finite value in timeline ${name}`);
      values[i * comps + c] = v;
    }
    if (i > 0 && times[i] < times[i - 1]) fail(`timeline ${name} keyframes are not sorted`);
    // Spine 4.1 stores a segment's curve on the keyframe it leaves (the
    // "source" keyframe); a curve on the last keyframe is unused. Audited over
    // all 318k curve groups in the input data: 186k fit only the source
    // segment, 39 only the destination segment.
    if (i + 1 < n) segments[i] = readCurve(kf.curve, comps, name);
  }
  return { times, values, segments, comps, name, duration: times[n - 1] };
}

function readCurve(curve, comps, name) {
  if (curve === undefined || curve === null || curve === 'linear') return null;
  if (curve === 'stepped') return { stepped: true };
  if (Array.isArray(curve) || ArrayBuffer.isView(curve)) {
    if (curve.length !== comps * 4) {
      fail(`timeline ${name} has ${curve.length} curve values, expected ${comps * 4}`);
    }
    const k = new Float64Array(comps * 4);
    for (let c = 0; c < comps * 4; c++) {
      const v = curve[c];
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`non-finite curve in timeline ${name}`);
      k[c] = v;
    }
    return k;
  }
  fail(`unsupported curve "${curve}" in timeline ${name}`);
  return null;
}

function sampleTimeline(tl, time, out) {
  const comps = tl.comps;
  const times = tl.times;
  const n = times.length;
  const values = tl.values;
  if (time <= times[0]) {
    for (let c = 0; c < comps; c++) out[c] = values[c];
    return;
  }
  if (time >= times[n - 1]) {
    const base = (n - 1) * comps;
    for (let c = 0; c < comps; c++) out[c] = values[base + c];
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo];
  const t1 = times[hi];
  const b0 = lo * comps;
  const b1 = hi * comps;
  const seg = tl.segments[lo];
  if (seg === undefined) fail(`timeline ${tl.name} is missing a segment`);
  if (seg && seg.stepped) {
    for (let c = 0; c < comps; c++) out[c] = values[b0 + c];
    return;
  }
  const span = t1 - t0;
  for (let c = 0; c < comps; c++) {
    const y0 = values[b0 + c];
    const y1 = values[b1 + c];
    if (!seg) {
      out[c] = span <= 0 ? y0 : y0 + (y1 - y0) * ((time - t0) / span);
    } else {
      const k = c * 4;
      const s = bezierSolve(time, t0, seg[k], seg[k + 2], t1);
      out[c] = cubicAt(y0, seg[k + 1], seg[k + 3], y1, s);
    }
  }
}

// ---------------------------------------------------------------------------
// Rig preparation
// ---------------------------------------------------------------------------

function buildBones(json) {
  const list = json.bones || [];
  const index = new Map();
  for (let i = 0; i < list.length; i++) index.set(list[i].name, i);
  const bones = list.map((b, i) => {
    const transform = b.transform === undefined ? 'normal' : b.transform;
    if (!TRANSFORM_MODES.has(transform)) fail(`unsupported bone transform mode "${transform}"`);
    if (b.skin !== undefined && typeof b.skin !== 'boolean') {
      fail(`bone ${b.name} has a non-boolean skin flag (${JSON.stringify(b.skin)})`);
    }
    let parent = -1;
    if (b.parent !== undefined) {
      parent = index.get(b.parent);
      if (parent === undefined) fail(`bone ${b.name} references missing parent ${b.parent}`);
    }
    return {
      index: i,
      name: b.name,
      parent,
      length: b.length || 0,
      x: b.x || 0,
      y: b.y || 0,
      rotation: b.rotation || 0,
      scaleX: b.scaleX === undefined ? 1 : b.scaleX,
      scaleY: b.scaleY === undefined ? 1 : b.scaleY,
      shearX: b.shearX || 0,
      shearY: b.shearY || 0,
      transform,
      // `skin` marks a bone that is only active while a skin listing it is
      // selected (see the Skins section of the public JSON format). 5 of the
      // 2483 flagged bones in this data are listed by no skin at all.
      skinBone: b.skin === true,
    };
  });
  const order = [];
  const state = new Uint8Array(bones.length);
  const visit = (i) => {
    if (state[i] === 2) return;
    if (state[i] === 1) fail(`bone hierarchy contains a cycle at ${bones[i].name}`);
    state[i] = 1;
    const p = bones[i].parent;
    if (p >= 0) visit(p);
    state[i] = 2;
    order.push(i);
  };
  for (let i = 0; i < bones.length; i++) visit(i);
  return { bones, order };
}

function regionFor(atlas, name, where) {
  if (!name) fail(`${where} has no atlas region name`);
  const region = atlas.regions.get(name);
  if (!region) fail(`atlas region "${name}" not found (${where})`);
  return region;
}

/** Region name for an attachment: `path` then `name` then the JSON key. */
function regionNameOf(raw, key) {
  if (raw.path) return raw.path;
  if (raw.name) return raw.name;
  return key;
}

function prepareRegionQuad(region, raw) {
  const width = raw.width === undefined ? region.originalWidth : raw.width;
  const height = raw.height === undefined ? region.originalHeight : raw.height;
  const scaleX = raw.scaleX === undefined ? 1 : raw.scaleX;
  const scaleY = raw.scaleY === undefined ? 1 : raw.scaleY;
  const rotation = (raw.rotation || 0) * DEG;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const s = region.scale || 1;
  // Trimmed rectangle inside the original (untrimmed) attachment frame. The
  // atlas trim offsets and the original size are in original-image units, and
  // the packed size is converted from page pixels to those units by the page
  // scale. Resizing the attachment (width/height != original size) scales both
  // the trim position and the trimmed size by attachment / original.
  const sx = width / region.originalWidth;
  const sy = height / region.originalHeight;
  const tw = (region.width / s) * sx;
  const th = (region.height / s) * sy;
  const lx0 = -width / 2 + region.offsetX * sx;
  const ly0 = -height / 2 + region.offsetY * sy;
  const lx1 = lx0 + tw;
  const ly1 = ly0 + th;
  const ax = raw.x || 0;
  const ay = raw.y || 0;
  const positions = new Float32Array(8);
  const uvs = new Float32Array(8);
  // corner order: bottom-left, bottom-right, top-right, top-left (logical frame, y up)
  const corners = [
    [lx0, ly0, 0, 0],
    [lx1, ly0, 1, 0],
    [lx1, ly1, 1, 1],
    [lx0, ly1, 0, 1],
  ];
  for (let i = 0; i < 4; i++) {
    const [lx, ly, u, v] = corners[i];
    // Attachment scale acts on the local axes *before* rotation (M = R * S).
    positions[i * 2] = ax + (lx * scaleX * cos - ly * scaleY * sin);
    positions[i * 2 + 1] = ay + (lx * scaleX * sin + ly * scaleY * cos);
    const uv = regionUvAt(region, u, v);
    uvs[i * 2] = uv[0];
    uvs[i * 2 + 1] = uv[1];
  }
  return { positions, uvs, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), vertexCount: 4, trimWidth: tw, trimHeight: th };
}

function decodeMeshInfluences(vertices, vertexCount, name) {
  // Weighted layout: per vertex [boneCount, (boneIndex, x, y, weight) * boneCount].
  // Flattened into parallel arrays; one entry per bone influence.
  const starts = new Int32Array(vertexCount + 1);
  const bone = [];
  const px = [];
  const py = [];
  const weight = [];
  let vi = 0;
  for (let v = 0; v < vertexCount; v++) {
    starts[v] = bone.length;
    const boneCount = vertices[vi++];
    if (!Number.isInteger(boneCount) || boneCount <= 0) {
      fail(`malformed weighted mesh vertex ${v} in ${name} (boneCount ${boneCount})`);
    }
    for (let b = 0; b < boneCount; b++) {
      bone.push(vertices[vi++]);
      px.push(vertices[vi++]);
      py.push(vertices[vi++]);
      weight.push(vertices[vi++]);
    }
  }
  starts[vertexCount] = bone.length;
  if (vi !== vertices.length) fail(`weighted mesh vertex data length mismatch in ${name}`);
  return {
    starts,
    bone: Int32Array.from(bone),
    x: Float64Array.from(px),
    y: Float64Array.from(py),
    weight: Float64Array.from(weight),
  };
}

/**
 * Unweighted meshes become one influence per vertex that names the slot bone
 * (-1). That keeps mesh rendering and deform indexing identical for both kinds
 * of mesh: the JSON deform array holds two floats per bone influence.
 */
function unweightedInfluences(vertices, vertexCount) {
  const starts = new Int32Array(vertexCount + 1);
  const bone = new Int32Array(vertexCount).fill(-1);
  const px = new Float64Array(vertexCount);
  const py = new Float64Array(vertexCount);
  const weight = new Float64Array(vertexCount).fill(1);
  for (let v = 0; v < vertexCount; v++) {
    starts[v] = v;
    px[v] = vertices[v * 2];
    py[v] = vertices[v * 2 + 1];
  }
  starts[vertexCount] = vertexCount;
  return { starts, bone, x: px, y: py, weight };
}

function classifyAttachment(raw, slotName, attName) {
  const type = raw.type === undefined ? 'region' : raw.type;
  if (type === 'region' || type === 'mesh' || type === 'linkedmesh') return type;
  if (type === 'boundingbox' || type === 'point') return 'nonvisible';
  fail(`unsupported attachment type "${type}" (${slotName}/${attName})`);
  return null;
}

function triangleArray(triangles, vertexCount, name) {
  let max = 0;
  for (let i = 0; i < triangles.length; i++) if (triangles[i] > max) max = triangles[i];
  if (max >= vertexCount) fail(`mesh ${name} triangle index out of range`);
  const Type = max > 65535 ? Uint32Array : Uint16Array;
  return Type.from(triangles);
}

function sequenceRegionName(path, sequence, frame) {
  const index = sequence.start + frame;
  const digits = sequence.digits;
  if (digits === undefined || digits === null) return path + index;
  return path + String(index).padStart(digits, '0');
}

// ---------------------------------------------------------------------------
// createRig
// ---------------------------------------------------------------------------

export function createRig(json, atlas) {
  if (!json || typeof json !== 'object') throw new TypeError('createRig expects a parsed skeleton JSON object');
  if (!atlas || !atlas.regions) throw new TypeError('createRig expects the result of parseAtlas()');
  const version = (json.skeleton && json.skeleton.spine) || 'unknown';
  if (!String(version).startsWith('4.1')) fail(`skeleton version ${version} is not a Spine 4.1 export`);

  const { bones, order } = buildBones(json);
  const slots = (json.slots || []).map((s, i) => {
    const bone = bones.findIndex((b) => b.name === s.bone);
    if (bone < 0) fail(`slot ${s.name} references missing bone ${s.bone}`);
    const blend = s.blend === undefined ? 'normal' : s.blend;
    if (!BLEND_MODES.has(blend)) fail(`unsupported slot blend mode "${blend}"`);
    const color = new Float32Array(4);
    if (s.color === undefined) color.set([1, 1, 1, 1]);
    else hexToRgba(s.color, color);
    return {
      index: i,
      name: s.name,
      bone,
      attachmentName: s.attachment === undefined ? null : s.attachment,
      blend,
      color,
      // `dark` only matters for tint-black materials, which are not modelled.
      dark: s.dark === undefined ? null : s.dark,
    };
  });
  const slotIndexByName = new Map(slots.map((s) => [s.name, s.index]));

  // --- skins -------------------------------------------------------------
  // Pass 1: collect raw entries for every skin and index meshes/regions.
  const boneIndexByName = new Map(bones.map((b) => [b.name, b.index]));
  const skinDefs = (json.skins || []).map((rawSkin) => {
    const name = rawSkin.name === undefined ? 'default' : rawSkin.name;
    const entries = [];
    const raw = rawSkin.attachments || {};
    for (const slotName of Object.keys(raw)) {
      const slotIndex = slotIndexByName.get(slotName);
      if (slotIndex === undefined) fail(`skin ${name} references missing slot ${slotName}`);
      for (const attName of Object.keys(raw[slotName])) {
        entries.push({ slotIndex, slotName, attName, raw: raw[slotName][attName], kind: classifyAttachment(raw[slotName][attName], slotName, attName) });
      }
    }
    // A skin's `bones` list names the skin-only bones that are active with it.
    const skinBones = new Set();
    for (const boneName of rawSkin.bones || []) {
      const boneIndex = boneIndexByName.get(boneName);
      if (boneIndex === undefined) fail(`skin ${name} lists missing bone ${boneName}`);
      skinBones.add(boneIndex);
    }
    return { name, entries, attachments: new Map(), baseByKey: new Map(), bones: skinBones };
  });
  if (skinDefs.length === 0) fail('skeleton has no skins');
  const skinByNameTmp = new Map();
  for (const s of skinDefs) if (!skinByNameTmp.has(s.name)) skinByNameTmp.set(s.name, s);

  const buildMeshBase = (e, skinDef) => {
    const att = e.raw;
    const uvs = att.uvs;
    const vertices = att.vertices;
    if (!uvs || !vertices) fail(`mesh ${e.slotName}/${e.attName} is missing uvs/vertices`);
    const vertexCount = uvs.length / 2;
    if (!Number.isInteger(vertexCount)) fail(`mesh ${e.attName} has an odd uv count`);
    const weighted = vertices.length !== vertexCount * 2;
    const infl = weighted ? decodeMeshInfluences(vertices, vertexCount, e.attName) : unweightedInfluences(vertices, vertexCount);
    return {
      kind: 'mesh',
      name: e.attName,
      slotIndex: e.slotIndex,
      vertexCount,
      weighted,
      influenceCount: infl.bone.length,
      influences: infl,
      logicalUvs: Float32Array.from(uvs),
      triangles: triangleArray(att.triangles || [], vertexCount, e.attName),
      deformScratch: new Float32Array(infl.bone.length * 2),
      clampedDeformFrames: 0,
    };
  };

  for (const skinDef of skinDefs) {
    for (const e of skinDef.entries) {
      if (e.kind === 'mesh') {
        const base = buildMeshBase(e, skinDef);
        skinDef.baseByKey.set(`${e.slotIndex}/${e.attName}`, base);
        skinDef.attachments.set(`${e.slotIndex}/${e.attName}`, {
          kind: 'mesh',
          name: e.attName,
          slotName: e.slotName,
          base,
          path: regionNameOf(e.raw, e.attName),
          color: attachColor(e.raw),
        });
      } else if (e.kind === 'nonvisible') {
        skinDef.attachments.set(`${e.slotIndex}/${e.attName}`, { kind: 'nonvisible', name: e.attName });
      } else {
        const raw = e.raw;
        const sequence = raw.sequence ? { count: raw.sequence.count, start: raw.sequence.start || 0, digits: raw.sequence.digits } : null;
        const path = regionNameOf(raw, e.attName);
        const regionName = sequence ? sequenceRegionName(path, sequence, 0) : path;
        const region = regionFor(atlas, regionName, `region ${e.slotName}/${e.attName}`);
        skinDef.attachments.set(`${e.slotIndex}/${e.attName}`, {
          kind: 'region',
          name: e.attName,
          slotName: e.slotName,
          raw,
          path,
          region,
          sequence,
          color: attachColor(raw),
          quad: prepareRegionQuad(region, raw),
          frames: null,
        });
      }
    }
  }

  // Pass 2: linked meshes (may reference meshes in another skin).
  for (const skinDef of skinDefs) {
    for (const e of skinDef.entries) {
      if (e.kind !== 'linkedmesh') continue;
      const raw = e.raw;
      const parentSkinName = raw.skin === undefined ? skinDef.name : raw.skin;
      const parentSkin = skinByNameTmp.get(parentSkinName);
      if (!parentSkin) fail(`linked mesh ${e.attName} references missing skin ${parentSkinName}`);
      const parentSlotName = raw.parentSlot === undefined ? e.slotName : raw.parentSlot;
      const parentSlotIndex = parentSlotName === e.slotName ? e.slotIndex : slotIndexByName.get(parentSlotName);
      if (parentSlotIndex === undefined) fail(`linked mesh ${e.attName} references missing parent slot ${parentSlotName}`);
      const parentBase = parentSkin.baseByKey.get(`${parentSlotIndex}/${raw.parent}`);
      if (!parentBase) fail(`linked mesh ${e.attName} cannot resolve parent mesh ${raw.parent} in skin ${parentSkinName}`);
      const region = regionFor(atlas, regionNameOf(raw, e.attName), `linkedmesh ${e.slotName}/${e.attName}`);
      skinDef.attachments.set(`${e.slotIndex}/${e.attName}`, {
        kind: 'linkedmesh',
        name: e.attName,
        slotName: e.slotName,
        base: parentBase,
        region,
        color: attachColor(raw),
        path: region.name,
      });
    }
  }

  // Pass 3: texture-space UVs per attachment (depends on the atlas region).
  for (const skinDef of skinDefs) {
    for (const att of skinDef.attachments.values()) {
      if (att.kind === 'mesh') {
        const region = regionFor(atlas, att.path, `mesh ${att.slotName}/${att.name}`);
        att.region = region;
        att.uvs = mapMeshUvs(att.base.logicalUvs, region);
      } else if (att.kind === 'linkedmesh') {
        att.uvs = mapMeshUvs(att.base.logicalUvs, att.region);
      } else if (att.kind === 'region' && att.sequence) {
        att.frames = [];
        for (let i = 0; i < att.sequence.count; i++) {
          const name = sequenceRegionName(att.path, att.sequence, i);
          const region = regionFor(atlas, name, `sequence ${att.name} frame ${i}`);
          att.frames.push({ region, quad: prepareRegionQuad(region, att.raw) });
        }
      }
    }
  }

  const skins = skinDefs.map((s) => ({
    name: s.name,
    attachments: s.attachments,
    baseByKey: s.baseByKey,
    bones: s.bones,
    boneNames: [...s.bones].map((i) => bones[i].name),
  }));
  const skinByName = new Map();
  for (const s of skins) if (!skinByName.has(s.name)) skinByName.set(s.name, s);

  // --- animations --------------------------------------------------------
  const animations = [];
  const animationByName = new Map();
  for (const animName of Object.keys(json.animations || {})) {
    const anim = prepareAnimation(json.animations[animName], animName, bones, slots, slotIndexByName, skins, skinByName);
    animations.push(anim);
    animationByName.set(animName, anim);
  }

  return {
    version,
    bones,
    order,
    slots,
    skins,
    skinNames: skins.map((s) => s.name),
    skinByName,
    animations,
    animationByName,
    atlas,
    skeleton: json.skeleton || {},
    json,
    scratch: null,
  };
}

function attachColor(raw) {
  if (raw.color === undefined) return null;
  return hexToRgba(raw.color, new Float32Array(4));
}

/**
 * Convert mesh JSON UVs into texture coordinates.
 *
 * Mesh `uvs` in the Spine JSON are normalized over the *original* (untrimmed)
 * image with a TOP-left origin: (0,0) is the original image's top-left corner
 * and v grows down. regionUvAt expects the *trimmed* region's bottom-left
 * frame instead, so each mesh UV is first expressed in that frame:
 *
 *   u = (mu * originalWidth - offsetX) / packedWidth
 *   v = ((1 - mv) * originalHeight - offsetY) / packedHeight
 *
 * where offsetX/offsetY are the left/bottom trims, originalWidth/Height the
 * untrimmed image size, and the packed size is converted from page pixels to
 * the same logical units by the page scale. Results may fall outside [0, 1]
 * (a mesh can extend beyond the trim rect) and are never clamped.
 */
function mapMeshUvs(logicalUvs, region) {
  const s = region.scale || 1;
  const packedWidth = region.width / s;
  const packedHeight = region.height / s;
  const out = new Float32Array(logicalUvs.length);
  for (let i = 0; i < logicalUvs.length; i += 2) {
    const mu = logicalUvs[i];
    const mv = logicalUvs[i + 1];
    const u = (mu * region.originalWidth - region.offsetX) / packedWidth;
    const v = ((1 - mv) * region.originalHeight - region.offsetY) / packedHeight;
    const uv = regionUvAt(region, u, v);
    out[i] = uv[0];
    out[i + 1] = uv[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Animation preparation
// ---------------------------------------------------------------------------

function readValue(kf, out) { out[0] = kf.value === undefined ? 0 : kf.value; }
function readValueOne(kf, out) { out[0] = kf.value === undefined ? 1 : kf.value; }
function readXY(kf, out) {
  out[0] = kf.x === undefined ? 0 : kf.x;
  out[1] = kf.y === undefined ? 0 : kf.y;
}
function readXYScale(kf, out) {
  out[0] = kf.x === undefined ? 1 : kf.x;
  out[1] = kf.y === undefined ? 1 : kf.y;
}

const BONE_TIMELINE_KINDS = {
  rotate: { comps: 1, read: readValue },
  translate: { comps: 2, read: readXY },
  scale: { comps: 2, read: readXYScale },
  shear: { comps: 2, read: readXY },
  translatex: { comps: 1, read: readValue },
  translatey: { comps: 1, read: readValue },
  scalex: { comps: 1, read: readValueOne },
  scaley: { comps: 1, read: readValueOne },
};

/** Attachment timeline: keyframe times plus attachment names (null = hidden). */
function makeAttachmentTimeline(keyframes, name) {
  if (!keyframes.length) return null;
  const times = new Float64Array(keyframes.length);
  const names = new Array(keyframes.length);
  for (let i = 0; i < keyframes.length; i++) {
    times[i] = keyframes[i].time === undefined ? 0 : keyframes[i].time;
    names[i] = keyframes[i].name === undefined ? null : keyframes[i].name;
    if (i > 0 && times[i] < times[i - 1]) fail(`timeline ${name} keyframes are not sorted`);
  }
  return { times, names, duration: times[times.length - 1], name };
}

function sampleAttachmentTimeline(tl, time) {
  const times = tl.times;
  if (time < times[0]) return null;
  let lo = 0;
  let hi = times.length - 1;
  if (time >= times[hi]) return tl.names[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  return tl.names[lo];
}

/**
 * Deform timeline.
 *
 * The JSON deform array holds two floats (local x/y offset) per *bone
 * influence*: one entry per vertex for unweighted meshes, one entry per
 * (vertex, bone) pair for weighted meshes. Verified against all 412 deform
 * timelines in the input data: for weighted meshes every deform range fits
 * 2 * influenceCount (287/287) while only 117/287 fit 2 * vertexCount, and 128
 * fit it exactly. Values past the end of a mesh are ignored (a few meshes share
 * stale deform data exported for a larger sibling attachment in the same slot).
 */
function makeDeformTimeline(keyframes, influenceCount, name, base) {
  if (!keyframes.length) return null;
  const limit = influenceCount * 2;
  const times = new Float64Array(keyframes.length);
  const segments = new Array(keyframes.length - 1);
  const frames = new Array(keyframes.length);
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    times[i] = kf.time === undefined ? 0 : kf.time;
    if (i > 0 && times[i] < times[i - 1]) fail(`timeline ${name} keyframes are not sorted`);
    const offset = kf.offset === undefined ? 0 : kf.offset;
    const vertices = kf.vertices;
    if (vertices === undefined) {
      // The JSON writer omits an all-zero deform frame.
      frames[i] = { offset: 0, vertices: new Float64Array(0) };
    } else {
      if (!Array.isArray(vertices) && !ArrayBuffer.isView(vertices)) fail(`deform frame ${i} of ${name} has invalid vertices`);
      if (offset + vertices.length > limit) base.clampedDeformFrames++;
      frames[i] = { offset, vertices: Float64Array.from(vertices) };
    }
    if (i + 1 < keyframes.length) {
      // Deform curves share one bezier across every value of the frame and are
      // stored on the source keyframe, like every other timeline.
      segments[i] = readCurve(kf.curve, 1, name);
    }
  }
  return { times, frames, segments, duration: times[times.length - 1], name, influenceCount };
}

function prepareSequenceTimeline(keyframes, att, name) {
  if (!keyframes.length) return null;
  const keys = keyframes.map((kf) => ({
    time: kf.time === undefined ? 0 : kf.time,
    mode: kf.mode === undefined ? 'hold' : kf.mode,
    index: kf.index === undefined ? 0 : kf.index,
    delay: kf.delay === undefined ? 0 : kf.delay,
  }));
  keys.sort((a, b) => a.time - b.time);
  if (keys[0].time > 0) keys.unshift({ time: 0, mode: keys[0].mode, index: 0, delay: keys[0].delay });
  return { keys, duration: keys[keys.length - 1].time, name, attachment: att };
}

function prepareAnimation(raw, name, bones, slots, slotIndexByName, skins, skinByName) {
  const boneNameToIndex = new Map(bones.map((b) => [b.name, b.index]));
  const boneTimelines = new Map();
  for (const boneName of Object.keys(raw.bones || {})) {
    const boneIndex = boneNameToIndex.get(boneName);
    if (boneIndex === undefined) fail(`animation ${name} animates missing bone ${boneName}`);
    const src = raw.bones[boneName];
    const set = {};
    for (const kind of Object.keys(src)) {
      const spec = BONE_TIMELINE_KINDS[kind];
      if (!spec) fail(`animation ${name} uses unsupported bone timeline "${kind}"`);
      const tl = makeTimeline(src[kind], spec.comps, spec.read, `${name}/${boneName}/${kind}`);
      if (tl) set[kind] = tl;
    }
    if (Object.keys(set).length) boneTimelines.set(boneIndex, set);
  }

  const slotTimelines = new Map();
  for (const slotName of Object.keys(raw.slots || {})) {
    const slotIndex = slotIndexByName.get(slotName);
    if (slotIndex === undefined) fail(`animation ${name} animates missing slot ${slotName}`);
    const src = raw.slots[slotName];
    const set = {};
    if (src.attachment) set.attachment = makeAttachmentTimeline(src.attachment, `${name}/${slotName}/attachment`);
    if (src.rgba) set.color = makeTimeline(src.rgba, 4, (kf, out) => { hexToRgba(kf.color, out); }, `${name}/${slotName}/rgba`);
    for (const key of Object.keys(src)) {
      if (key !== 'attachment' && key !== 'rgba') fail(`animation ${name} uses unsupported slot timeline "${key}"`);
    }
    if (Object.keys(set).length) slotTimelines.set(slotIndex, set);
  }

  const deforms = new Map(); // base attachment -> [deform timeline]
  const sequences = new Map(); // attachment -> sequence timeline
  for (const skinName of Object.keys(raw.attachments || {})) {
    const skin = skinByName.get(skinName);
    if (!skin) fail(`animation ${name} references missing skin ${skinName}`);
    const slotMap = raw.attachments[skinName];
    for (const slotName of Object.keys(slotMap)) {
      const slotIndex = slotIndexByName.get(slotName);
      if (slotIndex === undefined) fail(`animation ${name} references missing slot ${slotName}`);
      for (const attName of Object.keys(slotMap[slotName])) {
        const att = skin.attachments.get(`${slotIndex}/${attName}`);
        if (!att) fail(`animation ${name} references missing attachment ${skinName}/${slotName}/${attName}`);
        const src = slotMap[slotName][attName];
        for (const key of Object.keys(src)) {
          if (key === 'deform') {
            if (att.kind !== 'mesh' && att.kind !== 'linkedmesh') {
              fail(`animation ${name} deforms non-mesh attachment ${slotName}/${attName}`);
            }
            const tl = makeDeformTimeline(src.deform, att.base.influenceCount, `${name}/${slotName}/${attName}/deform`, att.base);
            if (tl) {
              let list = deforms.get(att.base);
              if (!list) {
                list = [];
                deforms.set(att.base, list);
              }
              list.push(tl);
            }
          } else if (key === 'sequence') {
            if (att.kind !== 'region' || !att.sequence) fail(`animation ${name} animates the sequence of a non-sequence attachment ${slotName}/${attName}`);
            const tl = prepareSequenceTimeline(src.sequence, att, `${name}/${slotName}/${attName}/sequence`);
            if (tl) sequences.set(att, tl);
          } else {
            fail(`animation ${name} uses unsupported attachment timeline "${key}"`);
          }
        }
      }
    }
  }

  let drawOrder = null;
  let duration = 0;
  const bump = (t) => { if (t > duration) duration = t; };

  if (raw.drawOrder && raw.drawOrder.length) {
    const n = slots.length;
    drawOrder = raw.drawOrder.map((kf) => {
      const order = new Int32Array(n);
      const pinned = new Map();
      for (const o of kf.offsets || []) {
        const slotIndex = slotIndexByName.get(o.slot);
        if (slotIndex === undefined) fail(`animation ${name} draw order references missing slot ${o.slot}`);
        const target = slotIndex + (o.offset || 0);
        if (target < 0 || target >= n) fail(`animation ${name} draw order target ${target} out of range for slot ${o.slot}`);
        if (pinned.has(target)) fail(`animation ${name} draw order has conflicting targets`);
        pinned.set(target, slotIndex);
      }
      const used = new Set(pinned.values());
      let rest = 0;
      for (let pos = 0; pos < n; pos++) {
        const pinnedSlot = pinned.get(pos);
        if (pinnedSlot !== undefined) {
          order[pos] = pinnedSlot;
        } else {
          while (used.has(rest)) rest++;
          if (rest >= n) fail(`animation ${name} draw order is not a permutation`);
          order[pos] = rest++;
        }
      }
      const time = kf.time === undefined ? 0 : kf.time;
      bump(time);
      return { time, order };
    });
  }

  for (const set of boneTimelines.values()) for (const tl of Object.values(set)) bump(tl.duration);
  for (const set of slotTimelines.values()) for (const tl of Object.values(set)) bump(tl.duration);
  for (const list of deforms.values()) for (const tl of list) bump(tl.duration);
  for (const tl of sequences.values()) bump(tl.duration);
  for (const ev of raw.events || []) bump(ev.time || 0);

  return {
    name,
    duration,
    boneTimelines,
    slotTimelines,
    deforms,
    sequences,
    drawOrder,
    events: raw.events || null,
    raw,
  };
}

/**
 * Duration (greatest keyframe time) of an animation. Accepts a raw Spine
 * animation JSON object or a prepared animation from createRig().animations.
 */
export function animationDuration(animationData) {
  if (!animationData || typeof animationData !== 'object') return 0;
  if (typeof animationData.duration === 'number') return animationData.duration;
  let duration = 0;
  const bump = (t) => { if (typeof t === 'number' && t > duration) duration = t; };
  const scanArrays = (obj) => {
    for (const name of Object.keys(obj || {})) {
      const group = obj[name];
      for (const kind of Object.keys(group || {})) {
        const list = group[kind];
        if (Array.isArray(list)) for (const kf of list) bump(kf.time);
      }
    }
  };
  scanArrays(animationData.bones);
  scanArrays(animationData.slots);
  // attachments[skin][slot][attachment][deform|sequence]
  for (const skinName of Object.keys(animationData.attachments || {})) {
    const slots = animationData.attachments[skinName];
    for (const slotName of Object.keys(slots || {})) {
      const attachments = slots[slotName];
      for (const attName of Object.keys(attachments || {})) {
        const kinds = attachments[attName];
        for (const kind of Object.keys(kinds || {})) {
          const list = kinds[kind];
          if (Array.isArray(list)) for (const kf of list) bump(kf.time);
        }
      }
    }
  }
  for (const kf of animationData.drawOrder || []) bump(kf.time);
  for (const kf of animationData.events || []) bump(kf.time);
  return duration;
}

// ---------------------------------------------------------------------------
// samplePose
// ---------------------------------------------------------------------------

function getScratch(rig) {
  const n = rig.bones.length;
  if (rig._scratch && rig._scratch.n === n) return rig._scratch;
  rig._scratch = {
    n,
    px: new Float64Array(n),
    py: new Float64Array(n),
    rotation: new Float64Array(n),
    scaleX: new Float64Array(n),
    scaleY: new Float64Array(n),
    shearX: new Float64Array(n),
    shearY: new Float64Array(n),
    wa: new Float64Array(n),
    wb: new Float64Array(n),
    wc: new Float64Array(n),
    wd: new Float64Array(n),
    wx: new Float64Array(n),
    wy: new Float64Array(n),
    slotColors: new Float32Array(rig.slots.length * 4),
    attachmentNames: new Array(rig.slots.length),
    drawOrder: new Int32Array(rig.slots.length),
    value: [0, 0, 0, 0],
    color: [0, 0, 0, 0],
  };
  return rig._scratch;
}

/**
 * Resolve the requested skin selection to skin objects.
 *
 * A string selects one skin. An array selects several partial skins to combine:
 * attachments are looked up in the selected skins in array order with the LAST
 * one taking priority, and then in `default` (the public JSON format specifies
 * that a skin which lacks an attachment falls back to the default skin). An
 * empty array therefore means "default only".
 */
function resolveSkinList(rig, skinName) {
  let names;
  if (skinName === undefined || skinName === null) names = ['default'];
  else if (typeof skinName === 'string') names = [skinName];
  else if (Array.isArray(skinName)) names = skinName;
  else fail(`skinName must be a string or an array of strings, got ${typeof skinName}`);
  const cacheKey = names.join('\u0000');
  if (rig._skinCache && rig._skinCache.has(cacheKey)) return rig._skinCache.get(cacheKey);
  const list = [];
  for (const n of names) {
    const s = rig.skinByName.get(n);
    if (!s) fail(`skin "${n}" not found (rig has: ${[...rig.skinByName.keys()].join(', ')})`);
    list.push(s);
  }
  if (!rig._skinCache) rig._skinCache = new Map();
  rig._skinCache.set(cacheKey, list);
  return list;
}

/** Resolve one attachment key (`slotIndex/attachmentName`) through the skin set. */
function lookupAttachment(rig, skinList, key) {
  for (let i = skinList.length - 1; i >= 0; i--) {
    const att = skinList[i].attachments.get(key);
    if (att) return att;
  }
  const def = rig.skinByName.get('default');
  if (def) return def.attachments.get(key) || null;
  return null;
}

/**
 * Active-bone mask for a skin selection.
 *
 * A bone is normally active. A bone exported with `"skin": true` is a skin bone:
 * the public JSON format makes it active only while a skin that lists it is
 * used, so the mask is the union of the `bones` arrays of `default` and of the
 * selected skins. Bones whose bone.skin flag is true but which no skin lists
 * are inactive for every selection (5 such bones exist in this data).
 *
 * Transforms are still evaluated for inactive bones so descendants keep correct
 * world placement; only drawing of slots attached to them is suppressed.
 */
function computeActiveBones(rig, skinList) {
  const n = rig.bones.length;
  if (!rig._activeScratch || rig._activeScratch.length !== n) rig._activeScratch = new Uint8Array(n);
  const active = rig._activeScratch;
  active.fill(1);
  const sets = [];
  const def = rig.skinByName.get('default');
  if (def) sets.push(def.bones);
  for (const s of skinList) sets.push(s.bones);
  for (let i = 0; i < n; i++) {
    if (!rig.bones[i].skinBone) continue;
    let on = false;
    for (const set of sets) {
      if (set && set.has(i)) {
        on = true;
        break;
      }
    }
    active[i] = on ? 1 : 0;
  }
  return active;
}

export function samplePose(rig, animationName, sourceTime, skinName = 'default') {
  if (!rig || !rig.bones) throw new TypeError('samplePose expects a rig from createRig()');
  const time = Number(sourceTime);
  if (!Number.isFinite(time)) throw new TypeError(`samplePose expects a finite time, got ${sourceTime}`);
  const skinList = resolveSkinList(rig, skinName);
  const activeBones = computeActiveBones(rig, skinList);
  let anim = null;
  if (animationName !== null && animationName !== undefined) {
    anim = rig.animationByName.get(animationName);
    if (!anim) fail(`animation "${animationName}" not found`);
  }

  const s = getScratch(rig);
  const { px, py, rotation, scaleX, scaleY, shearX, shearY, wa, wb, wc, wd, wx, wy, value } = s;
  const boneCount = rig.bones.length;
  for (let i = 0; i < boneCount; i++) {
    const b = rig.bones[i];
    px[i] = b.x;
    py[i] = b.y;
    rotation[i] = b.rotation;
    scaleX[i] = b.scaleX;
    scaleY[i] = b.scaleY;
    shearX[i] = b.shearX;
    shearY[i] = b.shearY;
  }

  if (anim) {
    for (const [boneIndex, set] of anim.boneTimelines) {
      const b = rig.bones[boneIndex];
      if (set.rotate) {
        sampleTimeline(set.rotate, time, value);
        rotation[boneIndex] = b.rotation + value[0];
      }
      if (set.translate) {
        sampleTimeline(set.translate, time, value);
        px[boneIndex] = b.x + value[0];
        py[boneIndex] = b.y + value[1];
      }
      if (set.translatex) {
        sampleTimeline(set.translatex, time, value);
        px[boneIndex] = b.x + value[0];
      }
      if (set.translatey) {
        sampleTimeline(set.translatey, time, value);
        py[boneIndex] = b.y + value[0];
      }
      if (set.scale) {
        sampleTimeline(set.scale, time, value);
        scaleX[boneIndex] = b.scaleX * value[0];
        scaleY[boneIndex] = b.scaleY * value[1];
      }
      if (set.scalex) {
        sampleTimeline(set.scalex, time, value);
        scaleX[boneIndex] = b.scaleX * value[0];
      }
      if (set.scaley) {
        sampleTimeline(set.scaley, time, value);
        scaleY[boneIndex] = b.scaleY * value[0];
      }
      if (set.shear) {
        sampleTimeline(set.shear, time, value);
        shearX[boneIndex] = b.shearX + value[0];
        shearY[boneIndex] = b.shearY + value[1];
      }
    }
  }

  // --- world transforms -------------------------------------------------
  //
  // The bone's local basis L has columns (la,lc) = scaleX * unit(rotation +
  // shearX) and (lb,ld) = scaleY * unit(rotation + 90 + shearY).
  //
  // Inheriting *directions* (noScale / noScaleOrReflection): each child axis is
  // mapped through the parent's full linear map P and renormalised, so the axis
  // DIRECTION follows P (including its nonuniform scale and shear) while the
  // axis LENGTH stays the child's own. Documented invariant: with a parent
  // diag(2,1) and a child rotated 45 degrees the child's x axis points along
  // (2,1) (~26.565 deg) at unit length, not 45 deg; the axes also become
  // non-orthogonal when P has shear.
  //
  // Inheriting *scales* without rotation (noRotationOrReflection): the parent's
  // rotation is removed by an upper-triangular (QR) decomposition
  // P = R * K, K = [[k11,k12],[0,k22]], and K is used as the parent basis. That
  // keeps the parent's nonuniform scale AND its shear in the world angle, where
  // diag(column lengths) would drop the shear. Reflection is removed by making
  // det(K) positive.
  for (const i of rig.order) {
    const b = rig.bones[i];
    const x = px[i];
    const y = py[i];
    const rx = (rotation[i] + shearX[i]) * DEG;
    const ry = (rotation[i] + 90 + shearY[i]) * DEG;
    const la = Math.cos(rx) * scaleX[i];
    const lc = Math.sin(rx) * scaleX[i];
    const lb = Math.cos(ry) * scaleY[i];
    const ld = Math.sin(ry) * scaleY[i];
    if (b.parent < 0) {
      wx[i] = x;
      wy[i] = y;
      wa[i] = la;
      wb[i] = lb;
      wc[i] = lc;
      wd[i] = ld;
      continue;
    }
    const p = b.parent;
    const pa = wa[p];
    const pb = wb[p];
    const pc = wc[p];
    const pd = wd[p];
    // The bone's origin always follows the parent's full world transform; the
    // transform mode only changes the linear part inherited below.
    wx[i] = pa * x + pb * y + wx[p];
    wy[i] = pc * x + pd * y + wy[p];
    switch (b.transform) {
      case 'normal':
        wa[i] = pa * la + pb * lc;
        wb[i] = pa * lb + pb * ld;
        wc[i] = pc * la + pd * lc;
        wd[i] = pc * lb + pd * ld;
        break;
      case 'onlyTranslation':
        wa[i] = la;
        wb[i] = lb;
        wc[i] = lc;
        wd[i] = ld;
        break;
      case 'noScale':
      case 'noScaleOrReflection': {
        let qa = pa;
        let qb = pb;
        let qc = pc;
        let qd = pd;
        // Remove the parent's reflection (if any) by negating its y axis column,
        // so the child does not inherit a mirrored parent. Which axis carried the
        // reflection is not recoverable from the world matrix alone (a negative
        // parent scaleX and a 180-degree rotation of a negative scaleY give the
        // same matrix), so this is a documented convention; 0 of the 43
        // noScaleOrReflection bones in this data have a reflected ancestor.
        if (b.transform === 'noScaleOrReflection' && qa * qd - qb * qc < 0) {
          qb = -qb;
          qd = -qd;
        }
        const v0x = qa * la + qb * lc;
        const v0y = qc * la + qd * lc;
        const v1x = qa * lb + qb * ld;
        const v1y = qc * lb + qd * ld;
        const n0 = Math.hypot(v0x, v0y);
        const n1 = Math.hypot(v1x, v1y);
        const m0 = Math.hypot(la, lc);
        const m1 = Math.hypot(lb, ld);
        // A parent that collapses an axis to zero leaves its direction undefined;
        // fall back to the child's own axis rather than producing NaN.
        wa[i] = n0 > 1e-12 ? (v0x / n0) * m0 : la;
        wb[i] = n1 > 1e-12 ? (v1x / n1) * m1 : lb;
        wc[i] = n0 > 1e-12 ? (v0y / n0) * m0 : lc;
        wd[i] = n1 > 1e-12 ? (v1y / n1) * m1 : ld;
        break;
      }
      case 'noRotationOrReflection': {
        // K = R(-angle of P's x axis) * P, upper triangular.
        const k11 = Math.hypot(pa, pc);
        let k12;
        let k22;
        if (k11 > 1e-12) {
          k12 = (pa * pb + pc * pd) / k11;
          k22 = (pa * pd - pb * pc) / k11;
        } else {
          k12 = 0;
          k22 = Math.hypot(pb, pd);
        }
        if (k22 < 0) {
          k12 = -k12;
          k22 = -k22;
        }
        wa[i] = k11 * la + k12 * lc;
        wb[i] = k11 * lb + k12 * ld;
        wc[i] = k22 * lc;
        wd[i] = k22 * ld;
        break;
      }
      default:
        fail(`unsupported bone transform mode "${b.transform}"`);
    }
  }

  // --- slot state -------------------------------------------------------
  const attachmentNames = s.attachmentNames;
  const slotColors = s.slotColors;
  for (let i = 0; i < rig.slots.length; i++) {
    attachmentNames[i] = rig.slots[i].attachmentName;
    slotColors.set(rig.slots[i].color, i * 4);
  }
  if (anim) {
    for (const [slotIndex, set] of anim.slotTimelines) {
      if (set.attachment) attachmentNames[slotIndex] = sampleAttachmentTimeline(set.attachment, time);
      if (set.color) {
        sampleTimeline(set.color, time, value);
        const o = slotIndex * 4;
        for (let c = 0; c < 4; c++) slotColors[o + c] = value[c];
      }
    }
  }

  // --- draw order -------------------------------------------------------
  let order = null;
  if (anim && anim.drawOrder && anim.drawOrder.length) {
    for (const f of anim.drawOrder) {
      if (f.time <= time) order = f.order;
      else break;
    }
  }
  if (!order) {
    order = s.drawOrder;
    for (let i = 0; i < order.length; i++) order[i] = i;
  }

  // --- deform -----------------------------------------------------------
  // buf holds two floats per bone influence (see makeDeformTimeline).
  const deformApplied = anim && anim.deforms.size ? new Map() : null;
  if (deformApplied) {
    for (const [base, list] of anim.deforms) {
      const buf = base.deformScratch;
      const limit = buf.length;
      buf.fill(0);
      for (const tl of list) {
        const times = tl.times;
        const n = times.length;
        let lo;
        let hi;
        if (time <= times[0]) {
          lo = 0;
          hi = 0;
        } else if (time >= times[n - 1]) {
          lo = n - 1;
          hi = n - 1;
        } else {
          lo = 0;
          hi = n - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (times[mid] <= time) lo = mid;
            else hi = mid;
          }
        }
        const frame = tl.frames[lo];
        const seg = lo === hi ? null : tl.segments[lo];
        if (lo === hi || (seg && seg.stepped)) {
          const off = frame.offset;
          const end = Math.min(off + frame.vertices.length, limit);
          for (let i = off; i < end; i++) buf[i] = frame.vertices[i - off];
          continue;
        }
        // Interpolate over the union of both frames' ranges; indices outside a
        // frame's window are implicitly zero.
        const next = tl.frames[hi];
        const start = Math.min(frame.offset, next.offset);
        const stop = Math.min(Math.max(frame.offset + frame.vertices.length, next.offset + next.vertices.length), limit);
        const t0 = times[lo];
        const t1 = times[hi];
        const u = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
        // A deform curve's y control points are a normalised 0..1 progress
        // (verified against deform frames whose values span hundreds of units,
        // while their control values stay in 0..1), shared by every value.
        let p = u;
        if (seg) {
          const s0 = bezierSolve(time, t0, seg[0], seg[2], t1);
          p = cubicAt(0, seg[1], seg[3], 1, s0);
        }
        for (let i = start; i < stop; i++) {
          const a = i - frame.offset;
          const b = i - next.offset;
          const v0 = a >= 0 && a < frame.vertices.length ? frame.vertices[a] : 0;
          const v1 = b >= 0 && b < next.vertices.length ? next.vertices[b] : 0;
          buf[i] = v0 + (v1 - v0) * p;
        }
      }
      deformApplied.set(base, buf);
    }
  }

  // --- draws ------------------------------------------------------------
  const draws = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const color = s.color;

  for (let o = 0; o < order.length; o++) {
    const slotIndex = order[o];
    const attName = attachmentNames[slotIndex];
    if (!attName) continue;
    const slot = rig.slots[slotIndex];
    // Skin-only bones do not draw unless the selected skin(s) contain them.
    if (!activeBones[slot.bone]) continue;
    const att = lookupAttachment(rig, skinList, `${slotIndex}/${attName}`);
    if (!att || att.kind === 'nonvisible') continue;
    const bone = slot.bone;
    const a = wa[bone];
    const b = wb[bone];
    const c = wc[bone];
    const d = wd[bone];
    const bx = wx[bone];
    const by = wy[bone];
    const o4 = slotIndex * 4;
    if (att.color) {
      for (let i = 0; i < 4; i++) color[i] = slotColors[o4 + i] * att.color[i];
    } else {
      for (let i = 0; i < 4; i++) color[i] = slotColors[o4 + i];
    }
    // Bezier-eased colour timelines can overshoot slightly; clamp like an 8 bit
    // framebuffer would (2 of 5142 audited poses overshoot to ~1.06).
    for (let i = 0; i < 4; i++) {
      const c = color[i];
      color[i] = c < 0 ? 0 : c > 1 ? 1 : c;
    }

    if (att.kind === 'region') {
      let quad = att.quad;
      let region = att.region;
      if (att.frames) {
        const frameIndex = evaluateSequence(att, anim, time);
        const frame = att.frames[clampInt(frameIndex, 0, att.frames.length - 1)];
        quad = frame.quad;
        region = frame.region;
      }
      const src = quad.positions;
      const positions = new Float32Array(8);
      for (let i = 0; i < 4; i++) {
        const lx = src[i * 2];
        const ly = src[i * 2 + 1];
        positions[i * 2] = a * lx + b * ly + bx;
        positions[i * 2 + 1] = c * lx + d * ly + by;
      }
      if (!finiteArray(positions)) fail(`non-finite position in region ${region.name}`);
      draws.push({
        page: region.page,
        region: region.name,
        positions,
        uvs: quad.uvs,
        indices: quad.indices,
        color: [color[0], color[1], color[2], color[3]],
        blend: slot.blend,
      });
      minX = Math.min(minX, positions[0], positions[2], positions[4], positions[6]);
      maxX = Math.max(maxX, positions[0], positions[2], positions[4], positions[6]);
      minY = Math.min(minY, positions[1], positions[3], positions[5], positions[7]);
      maxY = Math.max(maxY, positions[1], positions[3], positions[5], positions[7]);
      continue;
    }

    const base = att.base;
    const region = att.region;
    const vertexCount = base.vertexCount;
    const positions = new Float32Array(vertexCount * 2);
    const deform = deformApplied ? deformApplied.get(base) : null;
    const infl = base.influences;
    const starts = infl.starts;
    const infBone = infl.bone;
    const infX = infl.x;
    const infY = infl.y;
    const infW = infl.weight;
    for (let v = 0; v < vertexCount; v++) {
      const k0 = starts[v];
      const k1 = starts[v + 1];
      let x = 0;
      let y = 0;
      for (let k = k0; k < k1; k++) {
        const bi = infBone[k];
        // -1 marks the slot bone (unweighted mesh vertices).
        const ma = bi < 0 ? a : wa[bi];
        const mb = bi < 0 ? b : wb[bi];
        const mc = bi < 0 ? c : wc[bi];
        const md = bi < 0 ? d : wd[bi];
        const mx = bi < 0 ? bx : wx[bi];
        const my = bi < 0 ? by : wy[bi];
        // Deform offsets are stored per bone influence, in that influence's
        // own local frame (identical to the classic rule for unweighted meshes).
        const lx = infX[k] + (deform ? deform[k * 2] : 0);
        const ly = infY[k] + (deform ? deform[k * 2 + 1] : 0);
        const w = infW[k];
        x += (ma * lx + mb * ly + mx) * w;
        y += (mc * lx + md * ly + my) * w;
      }
      positions[v * 2] = x;
      positions[v * 2 + 1] = y;
    }
    if (!finiteArray(positions)) fail(`non-finite position in mesh ${att.name}`);
    draws.push({
      page: region.page,
      region: region.name,
      positions,
      uvs: att.uvs,
      indices: base.triangles,
      color: [color[0], color[1], color[2], color[3]],
      blend: slot.blend,
    });
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i];
      const y = positions[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (draws.length === 0) {
    minX = minY = maxX = maxY = 0;
  }
  return {
    draws,
    bounds: { minX, minY, maxX, maxY },
    animation: anim ? anim.name : null,
    time,
    // `skin` is the highest-priority selected skin (the whole selection when a
    // string was passed); `skins` is the full selection in lookup order.
    skin: skinList.length ? skinList[skinList.length - 1].name : 'default',
    skins: skinList.map((s) => s.name),
  };
}

function finiteArray(arr) {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

function evaluateSequence(att, anim, time) {
  if (!att.sequence) return 0;
  if (!anim) return 0;
  const tl = anim.sequences.get(att);
  if (!tl) return 0;
  let chosen = tl.keys[0];
  for (const k of tl.keys) {
    if (k.time <= time) chosen = k;
    else break;
  }
  const count = att.sequence.count;
  const base = chosen.index;
  const delay = chosen.delay;
  const advance = delay > 0 ? Math.floor(Math.max(0, time - chosen.time) / delay) : 0;
  switch (chosen.mode) {
    case 'hold':
      return base;
    case 'once':
      return Math.min(base + advance, count - 1);
    case 'loop':
      return count <= 0 ? 0 : (base + advance) % count;
    case 'pingpong': {
      if (count <= 1) return 0;
      const period = count * 2 - 2;
      const p = (base + advance) % period;
      return p < count ? p : period - p;
    }
    case 'random':
      fail(`sequence mode "random" is not supported (${att.name})`);
      return 0;
    default:
      fail(`unsupported sequence mode "${chosen.mode}" (${att.name})`);
      return 0;
  }
}

export default { createRig, samplePose, animationDuration };
