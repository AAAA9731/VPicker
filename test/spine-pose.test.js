// Mathematical tests for the independent Spine 4.1 pose evaluator.
//
// These tests use synthetic skeletons with hand-computed expected values plus a
// few checks against the real extracted data (build/spine-export). No Spine
// Runtime code is used or consulted.

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseAtlas, regionUvAt } from '../src/spine/atlas.js';
import { createRig, samplePose, animationDuration } from '../src/spine/pose.js';

const DEG = Math.PI / 180;
// Positions come back as Float32Array, so compare with float32-level tolerance.
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// Synthetic atlas
// ---------------------------------------------------------------------------

const ATLAS = `page.png
size:256,128
filter:Linear,Linear
plain
bounds:0,0,64,32
rot90
bounds:64,0,40,20
rotate:90
rot180
bounds:8,64,16,8
rotate:180
rot270
bounds:40,64,16,8
rotate:270
trimmed
bounds:200,10,16,8
offsets:10,20,40,40
trimrot
bounds:120,40,30,20
rotate:90
offsets:2,4,50,40
scaled.png
size:64,64
pma:true
scale:0.5
scaledreg
bounds:10,10,20,10
offsets:4,2,40,20
`;

function rigFor(json) {
  return createRig(json, parseAtlas(ATLAS));
}

function skeleton({ bones = [{ name: 'root' }], slots = [], skins = [{ name: 'default', attachments: {} }], animations = {} }) {
  return {
    skeleton: { spine: '4.1.24', x: 0, y: 0, width: 100, height: 100 },
    bones,
    slots,
    skins,
    animations,
  };
}

/** A slot holding one attachment on the root bone. */
function regionSlot(name, attachment) {
  return { name, bone: 'root', attachment };
}

function regionSkin(entries) {
  const attachments = {};
  for (const [slot, name, raw] of entries) {
    attachments[slot] = { [name]: raw };
  }
  return [{ name: 'default', attachments }];
}

describe('parseAtlas', () => {
  it('reads pages, sizes and pma', () => {
    const atlas = parseAtlas(ATLAS);
    expect(atlas.pages.length).toBe(2);
    expect(atlas.pages[0]).toMatchObject({ name: 'page.png', width: 256, height: 128, pma: false });
    expect(atlas.pages[1]).toMatchObject({ name: 'scaled.png', width: 64, height: 64, pma: true, scale: 0.5 });
    expect(atlas.regions.size).toBe(7);
  });

  it('keeps bounds as the logical (unrotated) size', () => {
    const { regions } = parseAtlas(ATLAS);
    const r = regions.get('rot90');
    expect([r.x, r.y, r.width, r.height]).toEqual([64, 0, 40, 20]);
    expect(r.footprintWidth).toBe(20);
    expect(r.footprintHeight).toBe(40);
    expect(r.rotate).toBe(90);
  });

  it('decodes offsets into original size and trim offset', () => {
    const { regions } = parseAtlas(ATLAS);
    const r = regions.get('trimmed');
    expect(r.originalWidth).toBe(40);
    expect(r.originalHeight).toBe(40);
    expect(r.offsetX).toBe(10);
    expect(r.offsetY).toBe(20);
  });

  it('applies the page scale to offsets and the original size', () => {
    const { regions } = parseAtlas(ATLAS);
    const r = regions.get('scaledreg');
    expect(r.width).toBe(20);
    expect(r.originalWidth).toBe(40 / 0.5);
    expect(r.originalHeight).toBe(20 / 0.5);
    expect(r.offsetX).toBe(4 / 0.5);
    expect(r.offsetY).toBe(2 / 0.5);
    expect(r.pma).toBe(true);
  });

  it('maps logical region corners onto the packed rect for every rotation', () => {
    const { regions } = parseAtlas(ATLAS);
    const expectUv = (name, u, v, ex, ey) => {
      const [x, y] = regionUvAt(regions.get(name), u, v);
      expect(close(x, ex)).toBe(true);
      expect(close(y, ey)).toBe(true);
    };
    // rotate 0: 64x32 at (0,0); logical bottom-left is the page bottom-left.
    expectUv('plain', 0, 0, 0 / 256, 32 / 128);
    expectUv('plain', 1, 1, 64 / 256, 0 / 128);
    // rotate 90: logical (0,0) -> page bottom-right of the footprint.
    expectUv('rot90', 0, 0, (64 + 20) / 256, (0 + 40) / 128);
    expectUv('rot90', 1, 1, 64 / 256, 0 / 128);
    expectUv('rot90', 1, 0, (64 + 20) / 256, 0 / 128);
    // rotate 180
    expectUv('rot180', 0, 0, (8 + 16) / 256, 64 / 128);
    expectUv('rot180', 1, 1, 8 / 256, (64 + 8) / 128);
    // rotate 270
    expectUv('rot270', 0, 0, 40 / 256, 64 / 128);
    expectUv('rot270', 1, 1, (40 + 8) / 256, (64 + 16) / 128);
  });

  it('rejects malformed atlas data', () => {
    expect(() => parseAtlas('page.png\nsize:10,10\nfoo\nbar:baz\n')).toThrow(/unknown region directive/);
    expect(() => parseAtlas('page.png\nsize:10,10\nr\nbounds:0,0,1,1\nrotate:45\n')).toThrow(/rotate/);
  });
});

describe('region attachments: geometry, trim and rotation', () => {
  it('builds an untrimmed quad centred on the attachment origin', () => {
    const rig = rigFor(skeleton({
      slots: [regionSlot('s', 'plain')],
      skins: regionSkin([['s', 'plain', { x: 0, y: 0, width: 64, height: 32 }]]),
    }));
    const draw = samplePose(rig, null, 0).draws[0];
    expect([...draw.positions]).toEqual([-32, -16, 32, -16, 32, 16, -32, 16]);
    expect(close(draw.uvs[0], 0)).toBe(true);
    expect(close(draw.uvs[1], 32 / 128)).toBe(true);
    expect(close(draw.uvs[4], 64 / 256)).toBe(true);
    expect(close(draw.uvs[5], 0)).toBe(true);
    expect(draw.page).toBe('page.png');
    expect(draw.blend).toBe('normal');
    expect([...draw.color]).toEqual([1, 1, 1, 1]);
  });

  it('places the trimmed sub-rect inside the original frame and only textures that sub-rect', () => {
    // original 40x40, trim offset (10,20), trimmed size 16x8
    const rig = rigFor(skeleton({
      slots: [regionSlot('s', 'trimmed')],
      skins: regionSkin([['s', 'trimmed', { x: 0, y: 0, width: 40, height: 40 }]]),
    }));
    const draw = samplePose(rig, null, 0).draws[0];
    expect([...draw.positions]).toEqual([-10, 0, 6, 0, 6, 8, -10, 8]);
    expect(close(draw.uvs[0], 200 / 256)).toBe(true);
    expect(close(draw.uvs[1], 18 / 128)).toBe(true);
    expect(close(draw.uvs[4], 216 / 256)).toBe(true);
    expect(close(draw.uvs[5], 10 / 128)).toBe(true);
  });

  it('handles a rotated region inside a trimmed frame', () => {
    // region 120,40 30x20 rotate 90, offsets 2,4,50,40 -> original 50x40
    const rig = rigFor(skeleton({
      slots: [regionSlot('s', 'trimrot')],
      skins: regionSkin([['s', 'trimrot', { x: 0, y: 0, width: 50, height: 40 }]]),
    }));
    const draw = samplePose(rig, null, 0).draws[0];
    // frame-relative trim rect: x in [-25+2, -25+2+30], y in [-20+4, -20+4+20]
    expect([...draw.positions]).toEqual([-23, -16, 7, -16, 7, 4, -23, 4]);
    // logical (0,0) -> rotate 90 -> page (120 + 20, 40 + 30)
    expect(close(draw.uvs[0], 140 / 256)).toBe(true);
    expect(close(draw.uvs[1], 70 / 128)).toBe(true);
    expect(close(draw.uvs[4], 120 / 256)).toBe(true);
    expect(close(draw.uvs[5], 40 / 128)).toBe(true);
  });

  it('applies attachment rotation, scale and translation', () => {
    const rig = rigFor(skeleton({
      slots: [regionSlot('s', 'plain')],
      skins: regionSkin([['s', 'plain', { x: 5, y: -3, rotation: 90, scaleX: 2, scaleY: 0.5, width: 64, height: 32 }]]),
    }));
    const p = samplePose(rig, null, 0).draws[0].positions;
    // corners (-32,-16) (32,-16) (32,16) (-32,16), scaled on the local axes
    // (x2, y0.5) first, then rotated 90 deg, then translated by (5,-3):
    // (-32,-16) -> (-64,-8) -> (8,-64) -> (13,-67), etc.
    expect([...p]).toEqual([13, -67, 13, 61, -3, 61, -3, -67]);
  });
});

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

function meshSkeleton(rawMesh, bones, extra = {}) {
  return skeleton({
    bones,
    slots: [regionSlot('s', 'm')],
    skins: [{ name: 'default', attachments: { s: { m: { type: 'mesh', path: 'plain', ...rawMesh } } } }],
    ...extra,
  });
}

describe('meshes', () => {
  it('transforms an unweighted mesh by the slot bone', () => {
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 1], vertices: [0, 0, 10, 4], triangles: [0] },
      [{ name: 'root', x: 3, y: 7, rotation: 90 }],
    );
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    // rotate (0,0) and (10,4) by 90 degrees and translate
    expect(close(p[0], 3)).toBe(true);
    expect(close(p[1], 7)).toBe(true);
    expect(close(p[2], 3 - 4)).toBe(true);
    expect(close(p[3], 7 + 10)).toBe(true);
  });

  it('weights a vertex across several bones', () => {
    // bone 0 at (0,0), bone 1 at (10,0); vertex 0 is 50/50 on both origins
    const json = meshSkeleton(
      {
        uvs: [0, 0, 1, 0, 0, 1],
        vertices: [
          2, 0, 0, 0, 0.5, 1, 0, 0, 0.5,
          1, 0, 4, 0, 1,
          1, 1, 0, 0, 1,
        ],
        triangles: [0, 1, 2],
      },
      [{ name: 'root' }, { name: 'b1', parent: 'root', x: 10 }],
    );
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    expect(close(p[0], 5)).toBe(true);
    expect(close(p[1], 0)).toBe(true);
    expect(close(p[2], 4)).toBe(true);
    expect(close(p[4], 10)).toBe(true);
  });

  it('maps mesh uvs through a rotated atlas region', () => {
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 1], vertices: [0, 0, 4, 4], triangles: [0] },
      [{ name: 'root' }],
    );
    // override the attachment to use the rot90 region through `path`
    json.skins[0].attachments.s.m.path = 'rot90';
    json.skins[0].attachments.s.m.width = 8;
    json.skins[0].attachments.s.m.height = 8;
    const draw = samplePose(rigFor(json), null, 0).draws[0];
    // Mesh uvs are normalized over the original image from its top-left, so
    // mesh uv (0,0) is the trimmed-region top-left (0,1) and (1,1) the
    // trimmed-region bottom-right (1,0).
    const uv = regionUvAt(parseAtlas(ATLAS).regions.get('rot90'), 0, 1);
    expect(close(draw.uvs[0], uv[0])).toBe(true);
    expect(close(draw.uvs[1], uv[1])).toBe(true);
    const uv2 = regionUvAt(parseAtlas(ATLAS).regions.get('rot90'), 1, 0);
    expect(close(draw.uvs[2], uv2[0])).toBe(true);
    expect(close(draw.uvs[3], uv2[1])).toBe(true);
  });

  it('maps original-image mesh uvs into the trimmed region frame', () => {
    // `trimmed`: original 40x40, trim 10 from the left and 20 from the bottom,
    // packed 16x8. Mesh uv (0,0) is the original top-left = (0,40) bottom-up:
    //   u = (0 - 10) / 16 = -0.625, v = (40 - 20) / 8 = 2.5
    //   -> page (200 - 10, 10 + (1 - 2.5) * 8) = (190, -2)
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 1], vertices: [0, 0, 4, 4], triangles: [0] },
      [{ name: 'root' }],
    );
    json.skins[0].attachments.s.m.path = 'trimmed';
    const draw = samplePose(rigFor(json), null, 0).draws[0];
    expect(close(draw.uvs[0], 190 / 256)).toBe(true);
    expect(close(draw.uvs[1], -2 / 128)).toBe(true);
    // Mesh uv (1,1) is the original bottom-right = (40,0):
    //   u = (40 - 10) / 16 = 1.875, v = (0 - 20) / 8 = -2.5
    //   -> page (200 + 30, 10 + (1 + 2.5) * 8) = (230, 38)
    expect(close(draw.uvs[2], 230 / 256)).toBe(true);
    expect(close(draw.uvs[3], 38 / 128)).toBe(true);
  });

  it('keeps mesh uvs in logical units on a scaled atlas page', () => {
    // `scaledreg` (page scale 0.5): original 80x40, trim 8 from the left and 4
    // from the bottom, packed 40x20 logical (bounds 20x10 page px / 0.5).
    // Mesh uv (0,0): u = (0 - 8) / 40 = -0.2, v = (40 - 4) / 20 = 1.8
    //   -> page (10 + (-0.2 * 20), 10 + (1 - 1.8) * 10) = (6, 2)
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 1], vertices: [0, 0, 4, 4], triangles: [0] },
      [{ name: 'root' }],
    );
    json.skins[0].attachments.s.m.path = 'scaledreg';
    const draw = samplePose(rigFor(json), null, 0).draws[0];
    expect(close(draw.uvs[0], 6 / 64)).toBe(true);
    expect(close(draw.uvs[1], 2 / 64)).toBe(true);
    // Mesh uv (1,1): u = (80 - 8) / 40 = 1.8, v = (0 - 4) / 20 = -0.2
    //   -> page (10 + 36, 10 + (1 + 0.2) * 10) = (46, 22)
    expect(close(draw.uvs[2], 46 / 64)).toBe(true);
    expect(close(draw.uvs[3], 22 / 64)).toBe(true);
  });
});

describe('deform', () => {
  const deformMesh = () => ({
    uvs: [0, 0, 1, 0, 0, 1],
    vertices: [
      2, 0, 0, 0, 0.5, 1, 0, 0, 0.5,
      1, 0, 4, 0, 1,
      1, 1, 0, 0, 1,
    ],
    triangles: [0, 1, 2],
  });
  const deformBones = () => [{ name: 'root' }, { name: 'b1', parent: 'root', x: 10 }];
  const withDeform = (deform) => meshSkeleton(deformMesh(), deformBones(), {
    animations: { a: { attachments: { default: { s: { m: { deform } } } } } },
  });

  it('applies deform per bone influence in each influence local frame', () => {
    // 4 floats = 2 influences x (dx,dy); shift influence 0 by +2 in x
    const json = withDeform([{ vertices: [2, 0, 0, 0] }]);
    const p = samplePose(rigFor(json), 'a', 0).draws[0].positions;
    // vertex 0 = 0.5*(0+2, 0) + 0.5*(10+0, 0) = 6
    expect(close(p[0], 6)).toBe(true);
    expect(close(p[1], 0)).toBe(true);
    // vertex 2 uses influence 2 (unchanged)
    expect(close(p[4], 10)).toBe(true);
  });

  it('honours the deform offset window (offset counts floats, two per influence)', () => {
    // influence 2 owns floats 4 and 5, so offset 4 targets the second vertex
    const json = withDeform([{ offset: 4, vertices: [3, 4] }]);
    const p = samplePose(rigFor(json), 'a', 0).draws[0].positions;
    expect(close(p[0], 5)).toBe(true);
    expect(close(p[2], 7)).toBe(true);
    expect(close(p[3], 4)).toBe(true);
  });

  it('interpolates linearly, stepped and per-segment bezier', () => {
    const linear = withDeform([
      { vertices: [0, 0, 0, 0] },
      { time: 1, vertices: [4, 0, 0, 0] },
    ]);
    expect(close(samplePose(rigFor(linear), 'a', 0.5).draws[0].positions[0], 6)).toBe(true);

    const stepped = withDeform([
      { vertices: [0, 0, 0, 0], curve: 'stepped' },
      { time: 1, vertices: [4, 0, 0, 0] },
    ]);
    expect(close(samplePose(rigFor(stepped), 'a', 0.5).draws[0].positions[0], 5)).toBe(true);
    expect(close(samplePose(rigFor(stepped), 'a', 1).draws[0].positions[0], 7)).toBe(true);

    // Deform curves carry a normalised 0..1 progress in their y control points;
    // control points on the diagonal reproduce linear interpolation.
    const bezier = withDeform([
      { vertices: [0, 0, 0, 0], curve: [1 / 3, 1 / 3, 2 / 3, 2 / 3] },
      { time: 1, vertices: [4, 0, 0, 0] },
    ]);
    expect(close(samplePose(rigFor(bezier), 'a', 0.5).draws[0].positions[0], 6)).toBe(true);
    expect(close(samplePose(rigFor(bezier), 'a', 0.25).draws[0].positions[0], 5.5)).toBe(true);
  });

  it('holds the first and last deform frame outside the keyframe range', () => {
    const json = withDeform([
      { vertices: [2, 0, 0, 0] },
      { time: 1, vertices: [4, 0, 0, 0] },
    ]);
    expect(close(samplePose(rigFor(json), 'a', -5).draws[0].positions[0], 6)).toBe(true);
    expect(close(samplePose(rigFor(json), 'a', 9).draws[0].positions[0], 7)).toBe(true);
  });

  it('ignores deform values past the end of the influence list', () => {
    const json = withDeform([{ vertices: [1, 0, 0, 0, 9, 9, 9, 9, 9] }]);
    const p = samplePose(rigFor(json), 'a', 0).draws[0].positions;
    expect(p.every((v) => Number.isFinite(v))).toBe(true);
    expect(close(p[0], 5.5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bone transform inheritance
// ---------------------------------------------------------------------------

describe('bone transform inheritance', () => {
  // root: translate (10,5), rotation 90, scale (2,3)
  // child: translate (4,0), no rotation/scale, unweighted 1-vertex mesh at (1,0)
  const UNWEIGHTED = { uvs: [0, 0], vertices: [1, 0], triangles: [] };
  function inheritRig(transform) {
    const bones = [
      { name: 'root', x: 10, y: 5, rotation: 90, scaleX: 2, scaleY: 3 },
      { name: 'child', parent: 'root', x: 4, y: 0 },
    ];
    if (transform) bones[1].transform = transform;
    const json = meshSkeleton(UNWEIGHTED, bones);
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    return rigFor(json);
  }

  it('composes parent and child matrices (normal)', () => {
    const p = samplePose(inheritRig('normal'), null, 0).draws[0].positions;
    expect(close(p[0], 10)).toBe(true);
    expect(close(p[1], 15)).toBe(true);
  });

  it('onlyTranslation keeps the parent placement but not its rotation or scale', () => {
    const p = samplePose(inheritRig('onlyTranslation'), null, 0).draws[0].positions;
    expect(close(p[0], 11)).toBe(true);
    expect(close(p[1], 13)).toBe(true);
  });

  it('noScale drops the parent scale but keeps its rotation', () => {
    const p = samplePose(inheritRig('noScale'), null, 0).draws[0].positions;
    expect(close(p[0], 10)).toBe(true);
    expect(close(p[1], 14)).toBe(true);
  });

  it('noScaleOrReflection matches noScale when the parent is not reflected', () => {
    const p = samplePose(inheritRig('noScaleOrReflection'), null, 0).draws[0].positions;
    expect(close(p[0], 10)).toBe(true);
    expect(close(p[1], 14)).toBe(true);
  });

  it('noRotationOrReflection removes the parent rotation but keeps its scale', () => {
    const p = samplePose(inheritRig('noRotationOrReflection'), null, 0).draws[0].positions;
    expect(close(p[0], 12)).toBe(true);
    expect(close(p[1], 13)).toBe(true);
  });

  it('noScale follows the parent nonuniform scale direction at the child size', () => {
    // Documented transform-inheritance invariant: a parent diag(2,1) with a
    // child rotated 45 deg puts the child's x axis along (2,1) (~26.565 deg) at
    // unit length, not at 45 deg.
    const bones = [
      { name: 'root', scaleX: 2, scaleY: 1 },
      { name: 'child', parent: 'root', rotation: 45, transform: 'noScale' },
    ];
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] },
      bones,
    );
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    const x = [p[2] - p[0], p[3] - p[1]];
    const y = [p[4] - p[0], p[5] - p[1]];
    expect(close(Math.atan2(x[1], x[0]) / DEG, Math.atan2(1, 2) / DEG, 1e-5)).toBe(true);
    expect(close(Math.hypot(x[0], x[1]), 1, 1e-6)).toBe(true);
    expect(close(Math.hypot(y[0], y[1]), 1, 1e-6)).toBe(true);
    // the parent's nonorthogonality is carried into the child axes (126.87 deg)
    const cross = x[0] * y[1] - x[1] * y[0];
    const dot = x[0] * y[0] + x[1] * y[1];
    expect(close(Math.abs(Math.atan2(cross, dot) / DEG), 126.8699, 1e-3)).toBe(true);
  });

  it('noScale keeps the parent shear in the child axes', () => {
    // Parent x axis at 30 deg (scaleX 2, shearX 30), y axis at 90 deg.
    const bones = [
      { name: 'root', scaleX: 2, shearX: 30 },
      { name: 'child', parent: 'root', transform: 'noScale' },
    ];
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] },
      bones,
    );
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    const x = [p[2] - p[0], p[3] - p[1]];
    const y = [p[4] - p[0], p[5] - p[1]];
    expect(close(Math.atan2(x[1], x[0]) / DEG, 30, 1e-5)).toBe(true);
    expect(close(Math.atan2(y[1], y[0]) / DEG, 90, 1e-5)).toBe(true);
    expect(close(Math.hypot(x[0], x[1]), 1, 1e-6)).toBe(true);
  });

  it('noScaleOrReflection removes a parent reflection without inheriting its scale', () => {
    const rigForScale = (transform, scaleY) => {
      const bones = [
        { name: 'root', scaleX: 1, scaleY },
        { name: 'child', parent: 'root', transform },
      ];
      const json = meshSkeleton(
        { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] },
        bones,
      );
      json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
      return samplePose(rigFor(json), null, 0).draws[0].positions;
    };
    // noScale inherits the mirror of diag(1,-1): the y axis points at -90 deg
    const mirrored = rigForScale('noScale', -1);
    expect(close(Math.atan2(mirrored[3] - mirrored[1], mirrored[2] - mirrored[0]) / DEG, 0)).toBe(true);
    expect(close(Math.atan2(mirrored[5] - mirrored[1], mirrored[4] - mirrored[0]) / DEG, -90)).toBe(true);
    // noScaleOrReflection removes it, giving the identity basis
    const clean = rigForScale('noScaleOrReflection', -1);
    expect(close(Math.atan2(clean[3] - clean[1], clean[2] - clean[0]) / DEG, 0)).toBe(true);
    expect(close(Math.atan2(clean[5] - clean[1], clean[4] - clean[0]) / DEG, 90)).toBe(true);
  });

  it('noRotationOrReflection keeps the parent scale and shear but drops its rotation', () => {
    // Parent x axis at 50 deg (rotation 30 + shearX 20, scaleX 2), y axis at
    // 120 deg. Removing the parent rotation turns the axes into 0 deg / 70 deg,
    // so diag(columnLengths) would wrongly produce 0 deg / 90 deg.
    const bones = [
      { name: 'root', rotation: 30, scaleX: 2, shearX: 20 },
      { name: 'child', parent: 'root', transform: 'noRotationOrReflection' },
    ];
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] },
      bones,
    );
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    const x = [p[2] - p[0], p[3] - p[1]];
    const y = [p[4] - p[0], p[5] - p[1]];
    expect(close(Math.atan2(x[1], x[0]) / DEG, 0, 1e-4)).toBe(true);
    expect(close(Math.hypot(x[0], x[1]), 2, 1e-4)).toBe(true);
    expect(close(Math.atan2(y[1], y[0]) / DEG, 70, 1e-4)).toBe(true);
    expect(close(Math.hypot(y[0], y[1]), 1, 1e-4)).toBe(true);
  });

  it('noRotationOrReflection still bends the world angle through a nonuniform parent', () => {
    const bones = [
      { name: 'root', rotation: 45, scaleX: 2, scaleY: 1 },
      { name: 'child', parent: 'root', rotation: 45, transform: 'noRotationOrReflection' },
    ];
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 0], vertices: [0, 0, 1, 0], triangles: [0] },
      bones,
    );
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    const x = [p[2] - p[0], p[3] - p[1]];
    // removing the parent rotation leaves diag(2,1), so the child's own 45 deg
    // axis still lands on the (2,1) direction (26.565 deg) at |diag(2,1)*(c,s)|
    expect(close(Math.atan2(x[1], x[0]) / DEG, Math.atan2(1, 2) / DEG, 1e-4)).toBe(true);
    expect(close(Math.hypot(x[0], x[1]), Math.hypot(2 * Math.cos(45 * DEG), Math.sin(45 * DEG)), 1e-4)).toBe(true);
  });

  it('supports negative parent scale (reflection)', () => {
    const bones = [
      { name: 'root', x: 0, y: 0, scaleX: -1, scaleY: 1 },
      { name: 'child', parent: 'root', x: 5, y: 0 },
    ];
    const json = meshSkeleton(UNWEIGHTED, bones);
    json.slots = [{ name: 's', bone: 'child', attachment: 'm' }];
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    expect(close(p[0], -6)).toBe(true);
    expect(close(p[1], 0)).toBe(true);
  });

  it('applies shear to the bone axes', () => {
    const bones = [{ name: 'root', shearX: 30 }];
    const json = meshSkeleton(
      { uvs: [0, 0, 1, 0], vertices: [0, 0, 1, 0], triangles: [0] },
      bones,
    );
    const p = samplePose(rigFor(json), null, 0).draws[0].positions;
    // x axis rotated by shearX, y axis still at 90 degrees
    expect(close(p[2], Math.cos(30 * DEG), 1e-6)).toBe(true);
    expect(close(p[3], Math.sin(30 * DEG), 1e-6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Numeric timelines
// ---------------------------------------------------------------------------

function boneTimelineRig(timelines, bones = [{ name: 'root' }]) {
  // vertices (0,0), (1,0), (0,1): positions expose translation, the bone x axis
  // and the bone y axis respectively.
  const json = meshSkeleton(
    { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] },
    bones,
  );
  json.animations = { a: { bones: { root: timelines } } };
  return json;
}

describe('numeric timelines', () => {
  const at = (json, t) => samplePose(rigFor(json), 'a', t).draws[0].positions;

  it('interpolates rotation linearly and adds it to the setup rotation', () => {
    const json = boneTimelineRig({ rotate: [{ value: 0 }, { time: 1, value: 90 }] });
    expect(close(at(json, 0.5)[2], Math.cos(45 * DEG))).toBe(true);
    expect(close(at(json, 0.5)[3], Math.sin(45 * DEG))).toBe(true);
  });

  it('honours stepped rotation', () => {
    const json = boneTimelineRig({ rotate: [{ value: 0, curve: 'stepped' }, { time: 1, value: 90 }] });
    expect(close(at(json, 0.9)[3], 0)).toBe(true);
    expect(close(at(json, 1)[2], 0)).toBe(true);
    expect(close(at(json, 1)[3], 1)).toBe(true);
  });

  it('evaluates an asymmetric bezier with the closed form for a linear x polynomial', () => {
    // x control points at 1/3 and 2/3 make x(s) = t0 + s * (t1 - t0)
    const json = boneTimelineRig({
      rotate: [{ value: 0, curve: [1 / 3, 10, 2 / 3, 80] }, { time: 1, value: 90 }],
    });
    const s = 0.5;
    const expected = 3 * (1 - s) ** 2 * s * 10 + 3 * (1 - s) * s ** 2 * 80 + s ** 3 * 90;
    const p = at(json, 0.5);
    expect(close(Math.atan2(p[3], p[2]) / DEG, expected, 1e-4)).toBe(true);
  });

  it('evaluates per-component bezier curves for translate', () => {
    const json = boneTimelineRig({
      translate: [
        { x: 0, y: 0, curve: [1 / 3, 10 / 3, 2 / 3, 20 / 3, 1 / 3, 0, 2 / 3, 0] },
        { time: 1, x: 10, y: 0 },
      ],
    });
    expect(close(at(json, 0.5)[0], 5, 1e-5)).toBe(true);
    expect(close(at(json, 0.5)[1], 0, 1e-5)).toBe(true);
    expect(close(at(json, 0.25)[0], 2.5, 1e-5)).toBe(true);
  });

  it('multiplies the setup scale by animated scale', () => {
    const bones = [{ name: 'root', scaleX: 4 }];
    const json = boneTimelineRig({ scale: [{ x: 0.5, y: 2 }, { time: 1, x: 1.5, y: 1 }] }, bones);
    expect(close(at(json, 0)[2], 4 * 0.5)).toBe(true);
    expect(close(at(json, 0)[5], 1 * 2)).toBe(true);
    expect(close(at(json, 1)[2], 4 * 1.5)).toBe(true);
    expect(close(at(json, 1)[5], 1 * 1)).toBe(true);
  });

  it('supports single-component timelines', () => {
    const json = boneTimelineRig({
      translatex: [{ value: 0 }, { time: 1, value: 8 }],
      translatey: [{ value: 0 }, { time: 1, value: 4 }],
    });
    expect(close(at(json, 0.5)[0], 4)).toBe(true);
    expect(close(at(json, 0.5)[1], 2)).toBe(true);
  });

  it('clamps time before the first and after the last keyframe', () => {
    const json = boneTimelineRig({ translate: [{ x: 3, y: 0 }, { time: 1, x: 9, y: 0 }] });
    expect(close(at(json, -2)[0], 3)).toBe(true);
    expect(close(at(json, 5)[0], 9)).toBe(true);
  });

  it('reports animation duration as the greatest keyframe time', () => {
    const raw = { bones: { root: { rotate: [{ value: 0 }, { time: 1.25, value: 10 }] } }, drawOrder: [{ time: 3 }] };
    expect(animationDuration(raw)).toBe(3);
    const json = boneTimelineRig({ rotate: [{ value: 0 }, { time: 2.5, value: 10 }] });
    const rig = rigFor(json);
    expect(rig.animations[0].duration).toBe(2.5);
    expect(animationDuration(rig.animations[0])).toBe(2.5);
    expect(animationDuration({})).toBe(0);
  });

  it('includes attachment (deform and sequence) timelines in the raw duration', () => {
    const raw = {
      attachments: { default: { s: { m: { deform: [{ vertices: [0, 0] }, { time: 4, vertices: [1, 1] }] } } } },
      slots: { s: { attachment: [{ name: 'a' }, { time: 0.5 }] } },
    };
    expect(animationDuration(raw)).toBe(4);
    const withSequence = {
      attachments: { default: { s: { m: { sequence: [{ mode: 'loop' }, { time: 1.75, mode: 'loop' }] } } } },
    };
    expect(animationDuration(withSequence)).toBe(1.75);
  });
});

// ---------------------------------------------------------------------------
// Slot timelines, draw order, sequences
// ---------------------------------------------------------------------------

describe('slot timelines', () => {
  const twoAttachmentRig = (slots) => ({
    skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
    bones: [{ name: 'root' }],
    slots,
    skins: [{
      name: 'default',
      attachments: {
        s: {
          a: { path: 'plain', x: 0, y: 0, width: 64, height: 32 },
          b: { path: 'plain', x: 0, y: 0, width: 64, height: 32 },
        },
      },
    }],
    animations: {},
  });

  it('switches attachments and hides a slot when a keyframe has no name', () => {
    const json = twoAttachmentRig([{ name: 's', bone: 'root', attachment: 'a' }]);
    json.animations = { a: { slots: { s: { attachment: [{ name: 'b' }, { time: 1 }] } } } };
    const rig = rigFor(json);
    expect(samplePose(rig, 'a', 0).draws.length).toBe(1);
    expect(samplePose(rig, 'a', 0.5).draws.length).toBe(1);
    expect(samplePose(rig, 'a', 1).draws.length).toBe(0);
    expect(samplePose(rig, null, 0).draws.length).toBe(1);
  });

  it('interpolates slot colour and multiplies by the attachment colour', () => {
    const json = twoAttachmentRig([{ name: 's', bone: 'root', attachment: 'a', color: 'ff0000ff' }]);
    json.skins[0].attachments.s.a.color = '80808080';
    json.animations = { a: { slots: { s: { rgba: [{ color: 'ff0000ff' }, { time: 1, color: '0000ff00' }] } } } };
    const rig = rigFor(json);
    const c0 = samplePose(rig, 'a', 0).draws[0].color;
    expect(close(c0[0], (255 / 255) * (128 / 255), 1e-6)).toBe(true);
    expect(close(c0[3], (255 / 255) * (128 / 255), 1e-6)).toBe(true);
    const c1 = samplePose(rig, 'a', 0.5).draws[0].color;
    expect(close(c1[0], 0.5 * (128 / 255), 1e-6)).toBe(true);
    expect(close(c1[2], 0.5 * (128 / 255), 1e-6)).toBe(true);
    expect(close(c1[3], 0.5 * (128 / 255), 1e-6)).toBe(true);
  });

  it('passes through the slot blend mode', () => {
    const json = twoAttachmentRig([{ name: 's', bone: 'root', attachment: 'a', blend: 'multiply' }]);
    expect(samplePose(rigFor(json), null, 0).draws[0].blend).toBe('multiply');
  });
});

// ---------------------------------------------------------------------------
// Skin selection: default fallback, partial-skin combination and skin bones
// ---------------------------------------------------------------------------

function skinSelectionRig() {
  const reg = (path) => ({ path, x: 0, y: 0 });
  return {
    skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'body', bone: 'root', attachment: 'bodyAtt' },
      { name: 'hair', bone: 'root', attachment: 'hairAtt' },
    ],
    skins: [
      { name: 'default', attachments: { body: { bodyAtt: reg('plain') }, hair: { hairAtt: reg('rot90') } } },
      { name: 'clothes', attachments: { body: { bodyAtt: reg('rot180') } } },
      { name: 'clothesB', attachments: { body: { bodyAtt: reg('rot270') } } },
      { name: 'accessory', attachments: { hair: { hairAtt: reg('trimmed') } } },
    ],
    animations: {},
  };
}

describe('skin selection', () => {
  it('falls back to the default skin for attachments a named skin omits', () => {
    const rig = rigFor(skinSelectionRig());
    expect(samplePose(rig, null, 0, 'default').draws.map((d) => d.region)).toEqual(['plain', 'rot90']);
    // body is overridden by `clothes`; hair is absent there and comes from default
    expect(samplePose(rig, null, 0, 'clothes').draws.map((d) => d.region)).toEqual(['rot180', 'rot90']);
  });

  it('combines partial skins in array order with later names taking priority', () => {
    const rig = rigFor(skinSelectionRig());
    const pose = samplePose(rig, null, 0, ['clothes', 'clothesB', 'accessory']);
    expect(pose.draws.map((d) => d.region)).toEqual(['rot270', 'trimmed']);
    expect(pose.skin).toBe('accessory');
    expect(pose.skins).toEqual(['clothes', 'clothesB', 'accessory']);
    expect(samplePose(rig, null, 0, ['clothesB', 'clothes']).draws[0].region).toBe('rot180');
  });

  it('exposes rig.skinNames and keeps the string API working', () => {
    const rig = rigFor(skinSelectionRig());
    expect(Array.isArray(rig.skins)).toBe(true);
    expect(rig.skinNames).toEqual(['default', 'clothes', 'clothesB', 'accessory']);
    expect(samplePose(rig, null, 0, 'accessory').draws.map((d) => d.region)).toEqual(['plain', 'trimmed']);
    expect(() => samplePose(rig, null, 0, 'nope')).toThrow(/skin "nope" not found/);
    expect(() => samplePose(rig, null, 0, ['clothes', 'nope'])).toThrow(/skin "nope" not found/);
  });

  it('still applies default-skin deform when a partial named skin is selected', () => {
    const json = {
      skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
      bones: [{ name: 'root' }],
      slots: [{ name: 's', bone: 'root', attachment: 'm' }],
      skins: [
        { name: 'default', attachments: { s: { m: { type: 'mesh', path: 'plain', uvs: [0, 0, 1, 0], vertices: [0, 0, 10, 0], triangles: [0] } } } },
        { name: 'extra', attachments: {} },
      ],
      animations: { a: { attachments: { default: { s: { m: { deform: [{ vertices: [2, 0, 0, 0] }] } } } } } },
    };
    const rig = rigFor(json);
    const setup = samplePose(rig, null, 0, 'extra').draws[0];
    expect(setup.region).toBe('plain');
    const posed = samplePose(rig, 'a', 0, 'extra').draws[0];
    expect(close(posed.positions[0], 2)).toBe(true);
  });
});

describe('skin bones (bone.skin)', () => {
  const skinBoneRig = (skinBones) => ({
    skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
    bones: [{ name: 'root' }, { name: 'skinBone', parent: 'root', skin: true }],
    slots: [{ name: 's', bone: 'skinBone', attachment: 'a' }],
    skins: [
      { name: 'default', attachments: { s: { a: { path: 'plain', x: 0, y: 0 } } } },
      { name: 'S', bones: skinBones, attachments: {} },
    ],
    animations: {},
  });

  it('draws a skin-bone slot only while a selected skin lists the bone', () => {
    const rig = rigFor(skinBoneRig(['skinBone']));
    expect(samplePose(rig, null, 0, 'default').draws.length).toBe(0);
    const pose = samplePose(rig, null, 0, 'S');
    expect(pose.draws.length).toBe(1);
    // the default skin still supplies the attachment once the bone is active
    expect(pose.draws[0].region).toBe('plain');
    expect(samplePose(rig, null, 0, ['default', 'S']).draws.length).toBe(1);
  });

  it('treats a bone.skin bone that no skin lists as inactive for every skin', () => {
    const rig = rigFor(skinBoneRig([]));
    expect(samplePose(rig, null, 0, 'default').draws.length).toBe(0);
    expect(samplePose(rig, null, 0, 'S').draws.length).toBe(0);
  });
});

describe('draw order', () => {
  it('applies relative offsets to the setup order and pins the moved slots', () => {
    const json = {
      skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
      bones: [{ name: 'root' }],
      slots: [
        { name: 's0', bone: 'root', attachment: 'a' },
        { name: 's1', bone: 'root', attachment: 'a' },
        { name: 's2', bone: 'root', attachment: 'a' },
      ],
      skins: [{ name: 'default', attachments: {
        s0: { a: { path: 'plain', x: 0, y: 0, width: 64, height: 32 } },
        s1: { a: { path: 'plain', x: 0, y: 0, width: 64, height: 32 } },
        s2: { a: { path: 'plain', x: 0, y: 0, width: 64, height: 32 } },
      } }],
      animations: {
        a: {
          drawOrder: [
            { offsets: [{ slot: 's2', offset: -2 }] },
            { time: 1, offsets: [{ slot: 's0', offset: 2 }] },
          ],
        },
      },
    };
    const rig = rigFor(json);
    // setup order is s0, s1, s2; the draws share one region name so use indices
    expect(samplePose(rig, null, 0).draws.length).toBe(3);
    const nameAt = (draws, i) => draws[i].positions.length;
    expect(nameAt(samplePose(rig, 'a', 0).draws, 0)).toBe(8);
    // identify order through distinct region names: rebuild with distinct paths
    const json2 = JSON.parse(JSON.stringify(json));
    json2.skins[0].attachments.s0.a.path = 'plain';
    json2.skins[0].attachments.s1.a.path = 'rot90';
    json2.skins[0].attachments.s2.a.path = 'rot180';
    json2.animations.a.drawOrder = json.animations.a.drawOrder;
    const rig2 = rigFor(json2);
    const order = (t) => samplePose(rig2, 'a', t).draws.map((d) => d.region);
    expect(order(0)).toEqual(['rot180', 'plain', 'rot90']);
    expect(order(1)).toEqual(['rot90', 'rot180', 'plain']);
  });
});

describe('sequence attachments', () => {
  it('selects the sequence frame from the region name and advances with delay', () => {
    const json = {
      skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
      bones: [{ name: 'root' }],
      slots: [{ name: 's', bone: 'root', attachment: 'seq0' }],
      skins: [{
        name: 'default',
        attachments: {
          s: {
            seq0: { path: 'plain', x: 0, y: 0, width: 64, height: 32, sequence: { count: 2, start: 0 } },
          },
        },
      }],
      animations: {},
    };
    // Add two regions named plain0 / plain1 to the synthetic atlas.
    const atlas = parseAtlas(ATLAS + 'plain0\nbounds:0,0,16,16\nplain1\nbounds:16,0,16,16\n');
    const rig = createRig(json, atlas);
    json.animations = { a: { attachments: { default: { s: { seq0: { sequence: [{ mode: 'loop', index: 0, delay: 0.5 }] } } } } } };
    const rig2 = createRig(json, atlas);
    expect(samplePose(rig, null, 0).draws[0].region).toBe('plain0');
    expect(samplePose(rig2, 'a', 0).draws[0].region).toBe('plain0');
    expect(samplePose(rig2, 'a', 0.6).draws[0].region).toBe('plain1');
    expect(samplePose(rig2, 'a', 1.1).draws[0].region).toBe('plain0');
  });
});

describe('linked meshes', () => {
  // A linked mesh shares its parent's geometry; the parent must live in the
  // same slot (Spine links attachments within a slot).
  const linkedJson = (slotAttachment) => ({
    skeleton: { spine: '4.1.24', x: 0, y: 0, width: 1, height: 1 },
    bones: [{ name: 'root' }],
    slots: [{ name: 's', bone: 'root', attachment: slotAttachment }],
    skins: [{
      name: 'default',
      attachments: {
        s: {
          parent: { type: 'mesh', path: 'plain', uvs: [0, 0, 1, 1], vertices: [0, 0, 4, 4], triangles: [0] },
          child: { type: 'linkedmesh', parent: 'parent', path: 'rot90' },
        },
      },
    }],
    animations: {},
  });

  it('inherits parent geometry and can override the region', () => {
    const parentDraw = samplePose(rigFor(linkedJson('parent')), null, 0).draws[0];
    expect(parentDraw.region).toBe('plain');
    expect([...parentDraw.positions]).toEqual([0, 0, 4, 4]);

    const childDraw = samplePose(rigFor(linkedJson('child')), null, 0).draws[0];
    expect(childDraw.region).toBe('rot90');
    expect([...childDraw.positions]).toEqual([0, 0, 4, 4]);
    const uv = regionUvAt(parseAtlas(ATLAS).regions.get('rot90'), 0, 1);
    expect(close(childDraw.uvs[0], uv[0])).toBe(true);
    expect(close(childDraw.uvs[1], uv[1])).toBe(true);
  });

  it('throws when the parent mesh cannot be resolved', () => {
    const broken = linkedJson('child');
    broken.skins[0].attachments.s.child.parent = 'missing';
    expect(() => createRig(broken, parseAtlas(ATLAS))).toThrow(/cannot resolve parent/);
  });
});

describe('error handling', () => {
  it('throws on unsupported versions, attachment types and missing regions', () => {
    const atlas = parseAtlas(ATLAS);
    expect(() => createRig({ skeleton: { spine: '4.0.0' }, bones: [], skins: [] }, atlas)).toThrow(/not a Spine 4.1/);
    const clipping = skeleton({
      slots: [regionSlot('s', 'c')],
      skins: [{ name: 'default', attachments: { s: { c: { type: 'clipping' } } } }],
    });
    expect(() => createRig(clipping, atlas)).toThrow(/unsupported attachment type/);
    const missing = skeleton({
      slots: [regionSlot('s', 'nope')],
      skins: regionSkin([['s', 'nope', { x: 0, y: 0, width: 4, height: 4 }]]),
    });
    expect(() => createRig(missing, atlas)).toThrow(/not found/);
  });

  it('throws for an unknown skin name', () => {
    const rig = rigFor(skeleton({
      slots: [regionSlot('s', 'plain')],
      skins: regionSkin([['s', 'plain', { x: 0, y: 0, width: 64, height: 32 }]]),
    }));
    expect(() => samplePose(rig, null, 0, 'nope')).toThrow(/skin "nope" not found/);
    expect(() => samplePose(rig, 'missing', 0)).toThrow(/animation "missing" not found/);
    expect(() => samplePose(rig, null, NaN)).toThrow(/finite/);
  });

  it('ignores non-visible bounding box attachments', () => {
    const json = skeleton({
      slots: [regionSlot('s', 'bb')],
      skins: [{ name: 'default', attachments: { s: { bb: { type: 'boundingbox', vertices: [0, 0, 1, 1] } } } }],
    });
    expect(samplePose(rigFor(json), null, 0).draws.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real extracted data
// ---------------------------------------------------------------------------

const EXPORT = path.resolve(process.cwd(), 'build/spine-export');
const hasExport = fs.existsSync(EXPORT);

function loadReal(dir) {
  const files = fs.readdirSync(dir);
  const jf = files.find((f) => f.endsWith('.json'));
  const af = files.find((f) => f.endsWith('.atlas'));
  const json = JSON.parse(fs.readFileSync(path.join(dir, jf), 'utf8'));
  const atlas = parseAtlas(fs.readFileSync(path.join(dir, af), 'utf8'));
  return { rig: createRig(json, atlas), json };
}

describe.skipIf(!hasExport)('real extracted data', () => {
  it('reproduces the setup pose bounds Spine exported (validates the whole chain)', () => {
    const dirs = [
      'SpineAnimEn/enemy_labo_fly__enemy_labo_fly',
      'SpineAnim/bench',
      'SpineAnimEn/leechqueen__leechqueen',
      'SpineAnim/stand_normal',
    ];
    let checked = 0;
    for (const rel of dirs) {
      const dir = path.join(EXPORT, rel);
      if (!fs.existsSync(dir)) continue;
      const { rig, json } = loadReal(dir);
      const skel = json.skeleton;
      const x = skel.x === undefined ? 0 : skel.x;
      const pose = samplePose(rig, null, 0, 'default');
      expect(pose.draws.length).toBeGreaterThan(0);
      expect(Math.abs(pose.bounds.minX - x)).toBeLessThan(0.1);
      expect(Math.abs(pose.bounds.minY - skel.y)).toBeLessThan(0.1);
      expect(Math.abs(pose.bounds.maxX - (x + skel.width))).toBeLessThan(0.1);
      expect(Math.abs(pose.bounds.maxY - (skel.y + skel.height))).toBeLessThan(0.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('samples a weighted-mesh skeleton with finite output and complete pages', () => {
    const dir = path.join(EXPORT, 'Fatal/fatal_nusi_0');
    if (!fs.existsSync(dir)) return;
    const { rig } = loadReal(dir);
    const pages = new Set(rig.atlas.pages.map((p) => p.name));
    let draws = 0;
    for (const anim of rig.animations) {
      for (const t of [0, anim.duration * 0.5, anim.duration]) {
        const pose = samplePose(rig, anim.name, t, 'default');
        for (const d of pose.draws) {
          draws++;
          expect(pages.has(d.page)).toBe(true);
          expect(d.positions.every(Number.isFinite)).toBe(true);
          expect(d.uvs.every(Number.isFinite)).toBe(true);
          expect(d.positions.length).toBe(d.uvs.length);
        }
      }
    }
    expect(draws).toBeGreaterThan(0);
  });
});
