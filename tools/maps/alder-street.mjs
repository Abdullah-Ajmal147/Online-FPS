// Generates packages/content/src/maps/alder-street.json: a small coastal town with houses you
// can walk into. Run: node tools/maps/alder-street.mjs && pnpm exec prettier --write packages/content/src/maps
//
// Built from the same primitives as every map (boxes, ramps, stairs; quarter-turn yaws). Only
// one half is described here; every piece is copied with a 180° turn about the centre, so the
// map is point-symmetric (the content tests check it): both teams get the same map.
//
// Layout (north = -Z, team 1; south = +Z, team 0), 64 × 84 m:
// - Main street down the middle (x -5..5): long sightlines, parked cars for cover.
// - Two-storey houses either side, open to walk through: street door, back door, windows on
//   both floors (the upper ones overlook the street), stairs inside.
// - Town square in the centre (point B) with a low fountain and planters.
// - Back alleys on the flanks (x ±20..±31): garden fences, sheds (points A and C).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/content/src/maps/alder-street.json',
);
const r = (v) => Math.round(v * 1000) / 1000;
const half = [];
const box = (center, size, material) =>
  half.push({ kind: 'box', center: center.map(r), size: size.map(r), material });

const T = 0.3; // wall thickness
const STOREY = 3.2;

/**
 * A wall along X (at z) or along Z (at x) from a to b, height y0..y1, with openings
 * { at: centre along the wall, w: width, bottom, top } cut out (doors from the floor).
 */
function wall(axis, fixed, a, b, y0, y1, openings = [], material = 'wall') {
  const piece = (s0, s1, h0, h1) => {
    if (s1 - s0 < 0.01 || h1 - h0 < 0.01) return;
    const mid = (s0 + s1) / 2;
    const len = s1 - s0;
    const y = (h0 + h1) / 2;
    if (axis === 'x') box([mid, y, fixed], [len, h1 - h0, T], material);
    else box([fixed, y, mid], [T, h1 - h0, len], material);
  };
  // Openings may overlap along the wall (a door under a window): cut the wall into columns
  // at every opening edge, and in each column keep the height not covered by an opening.
  const edges = [a, b];
  for (const o of openings) edges.push(o.at - o.w / 2, o.at + o.w / 2);
  const cols = [...new Set(edges.map(r))].filter((e) => e >= a && e <= b).sort((p, q) => p - q);
  for (let i = 0; i < cols.length - 1; i++) {
    const [c0, c1] = [cols[i], cols[i + 1]];
    const mid = (c0 + c1) / 2;
    const holes = openings
      .filter((o) => o.at - o.w / 2 <= mid && mid <= o.at + o.w / 2)
      .map((o) => [o.bottom, o.top])
      .sort((p, q) => p[0] - q[0]);
    let h = y0;
    for (const [h0, h1] of holes) {
      piece(c0, c1, h, Math.max(h, h0));
      h = Math.max(h, h1);
    }
    piece(c0, c1, h, y1);
  }
}

const door = (at) => ({ at, w: 1.6, bottom: 0, top: 2.3 });
const window1 = (at) => ({ at, w: 1.4, bottom: 1.0, top: 2.1 });
const window2 = (at) => ({ at, w: 1.4, bottom: STOREY + 1.0, top: STOREY + 2.1 });

/**
 * A two-storey house, centre (cx, cz), `w` along X, `d` along Z. The street side is the side
 * facing x = 0. Ground floor: doors front and back, a window each side. Upper floor: windows
 * all round (street windows = overlooks). Stairs inside along the far wall; the upper floor has
 * an opening above them.
 */
function house(cx, cz, w = 9, d = 8) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const streetX = Math.abs(x0) < Math.abs(x1) ? x0 : x1; // the wall facing the street
  const backX = streetX === x0 ? x1 : x0;
  const top = STOREY * 2;
  // Street and back walls (along Z): door + window below, two windows above.
  for (const [x, doorAt] of [
    [streetX, cz - 1.6],
    [backX, cz + 1.6],
  ])
    wall('z', x, z0, z1, 0, top, [
      door(doorAt),
      window1(cz + (x === streetX ? 1.9 : -1.9)),
      window2(cz - 1.9),
      window2(cz + 1.9),
    ]);
  // Side walls (along X): a window below and above.
  for (const z of [z0, z1])
    wall('x', z, x0 + T / 2, x1 - T / 2, 0, top, [window1(cx), window2(cx)]);
  // Stairs along the side wall at z1, climbing towards the street... the stairs rise away from
  // the back wall: 16 steps of 0.2 m up to the upper floor.
  const steps = 16;
  const stepRise = STOREY / steps;
  const stepDepth = 0.28;
  const run = steps * stepDepth;
  const inward = streetX < backX ? 1 : -1; // +1: street is at lower x
  const stairX0 = backX - inward * (T / 2 + 0.3); // start just inside the back wall
  const stairZ = z1 - T / 2 - 0.7; // along the side wall, 1.2 m wide
  // yaw 90: climbs towards -X; yaw 270: climbs towards +X (stairs climb along local -Z).
  half.push({
    kind: 'stairs',
    start: [r(stairX0), 0, r(stairZ)],
    width: 1.2,
    steps,
    stepRise: r(stepRise),
    stepDepth,
    yawDeg: inward > 0 ? 90 : 270,
    material: 'stairs',
  });
  // Upper floor slab with a stairwell opening (the strip above the stairs).
  const slabY = STOREY - 0.1;
  const innerX0 = x0 + T / 2;
  const innerX1 = x1 - T / 2;
  const innerZ0 = z0 + T / 2;
  const innerZ1 = z1 - T / 2;
  const wellZ0 = stairZ - 0.6;
  // Main slab (everything but the 1.2 m strip along z1).
  box([cx, slabY, (innerZ0 + wellZ0) / 2], [innerX1 - innerX0, 0.2, wellZ0 - innerZ0], 'platform');
  // The strip beside the stairwell (over the part of the stair run that is not needed).
  const wellX = inward > 0 ? [stairX0 - run - 0.2, innerX0] : [innerX1, stairX0 + run + 0.2];
  const [sx0, sx1] = [Math.min(...wellX), Math.max(...wellX)];
  if (sx1 - sx0 > 0.2)
    box(
      [(sx0 + sx1) / 2, slabY, (wellZ0 + innerZ1) / 2],
      [sx1 - sx0, 0.2, innerZ1 - wellZ0],
      'platform',
    );
  // Ceiling of the upper floor, then a pitched roof: two tiled slopes meeting at a ridge
  // along the house (solid wedges; ramps climb along their local -Z).
  box([cx, top + 0.1, cz], [w, 0.2, d], 'platform');
  const rise = Math.round((w / 2) * 0.62 * 100) / 100; // ~32° pitch
  const eave = 0.35;
  const slope = (x, yawDeg) =>
    half.push({
      kind: 'ramp',
      base: [r(x), r(top + 0.2), r(cz)],
      width: r(d + eave * 2),
      run: r(w / 2 + eave),
      rise,
      yawDeg,
      material: 'ramp',
    });
  slope(x1 + eave, 90); // climbs towards -X, up to the ridge
  slope(x0 - eave, 270); // climbs towards +X
}

// ---- The street and outer walls (each is its own twin or gets one) -------------------------
box([0, -0.5, 0], [64, 1, 84], 'floor'); // symmetric by itself: only once
// Outer walls: south and east here; the turn makes north and west.
box([0, 3, 42.5], [66, 6, 1], 'wall');
box([32.5, 3, 0], [1, 6, 84], 'wall');

// ---- Houses: west side north of centre, east side further north (twins fill the rest) -------
house(-12, 16);
house(12, 25);
house(-12, 30);
// Low garden walls between the houses and the square.
box([-12, 0.5, 9.5], [8, 1, 0.4], 'wall');
box([12, 0.5, 19], [8, 1, 0.4], 'wall');

// ---- Main street cover: parked cars and a bus shelter ------------------------------------------
box([-3, 0.65, 13], [1.9, 1.3, 4.3], 'prop');
box([3.2, 0.65, 21], [1.9, 1.3, 4.3], 'prop');
box([-3.2, 0.65, 29], [1.9, 1.3, 4.3], 'prop');
box([4, 1.2, 7], [0.2, 2.4, 3], 'wall'); // shelter back wall
box([4.9, 2.45, 7], [2, 0.1, 3.2], 'platform'); // shelter roof

// ---- Town square: fountain on the centre line + planters -------------------------------------
box([0, 0.5, 1.6], [4, 1, 0.4], 'wall'); // fountain rim (south half; its twin closes it)
box([1.8, 0.5, 0], [0.4, 1, 2.8], 'wall');
box([6.5, 0.45, 3.5], [2.4, 0.9, 1.2], 'prop'); // planters
box([-6.5, 0.45, 3.5], [2.4, 0.9, 1.2], 'prop');

// ---- Back alleys: fences and sheds --------------------------------------------------------------
for (const z of [11, 21, 35]) box([-24.5, 0.6, z], [7, 1.2, 0.3], 'prop'); // garden fences
box([-27.5, 1.2, 25.5], [3, 2.4, 3.5], 'prop'); // shed
box([24, 1.2, 36], [3.5, 2.4, 3], 'prop'); // shed
box([22, 0.6, 12], [0.3, 1.2, 6], 'prop'); // fence
box([26, 0.75, 20], [2.4, 1.5, 1.2], 'prop'); // crates

// ---- Mirror: every piece gets its 180° twin --------------------------------------------------
const flip = ([x, y, z]) => [r(-x) + 0, y, r(-z) + 0];
const turn = (yaw) => (yaw + 180) % 360;
const geometry = [];
for (const g of half) {
  geometry.push(g);
  if (g.kind === 'box') {
    const isSelf = g.center[0] === 0 && g.center[2] === 0;
    if (!isSelf) geometry.push({ ...g, center: flip(g.center) });
  } else if (g.kind === 'stairs')
    geometry.push({ ...g, start: flip(g.start), yawDeg: turn(g.yawDeg) });
  else if (g.kind === 'ramp') geometry.push({ ...g, base: flip(g.base), yawDeg: turn(g.yawDeg) });
}

// Spawns: team 0 south (facing north, yaw 0), team 1 north.
const south = [-15, -9, -3, 3, 9, 15].map((x) => ({ team: 0, position: [x, 0, 38.5], yawDeg: 0 }));
const spawns = [
  ...south,
  ...south.map((s) => ({ team: 1, position: flip(s.position), yawDeg: 180 })),
];

const map = {
  id: 'alder-street',
  name: 'Alder Street',
  location: 'Alder Street, a harbour town, late afternoon',
  description:
    'The Relay war emptied this harbour town. Brick houses line the main street; every door is open, and the upstairs windows watch the square.',
  killY: -20,
  lighting: 'golden',
  spawns,
  points: [
    { id: 'A', position: [-24, 0, 16] },
    { id: 'B', position: [0, 0, 0] }, // the fountain: its own mirror image
    { id: 'C', position: [24, 0, -16] },
  ],
  geometry,
};
writeFileSync(OUT, `${JSON.stringify(map, null, 2)}\n`);
console.log(`wrote ${OUT}: ${geometry.length} pieces`);
