import { describe, expect, it } from 'vitest';
import {
  MapSchema,
  ModeSchema,
  MovementSchema,
  WeaponSchema,
  defaultLoadout,
  maps,
  modes,
  movement,
  EquipmentSchema,
  KILL_SOURCE_FRAG,
  MAP_ROTATION,
  equipment,
  killSourceName,
  MAX_ATTACHMENTS,
  activeChallenges,
  challengeData,
  challengeProgress,
  MAX_WEAPON_LEVEL,
  NEW_PLAYER,
  hasAttachment,
  hasPerk,
  hasWeapon,
  levelFor,
  progression,
  weaponLevelFor,
  xpBreakdown,
  xpForMatch,
  MAX_PERKS,
  applyModifiers,
  attachmentCatalog,
  buildLoadout,
  loadoutFromWire,
  loadoutToWire,
  perkCatalog,
  resolveLoadout,
  weaponCatalog,
  weaponIndex,
  weapons,
} from './index.ts';
import { weaponFileNames } from './weapons/catalog.gen.ts';

// Vite (and so Vitest) expands import.meta.glob at build time: the list of files on disk.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, unknown>;
  }
}

describe('content', () => {
  it('loads Team Deathmatch as 6v6', () => {
    const tdm = modes['team-deathmatch'];
    expect(tdm?.teams).toBe(2);
    expect(tdm?.playersPerTeam).toBe(6);
  });

  it('rejects invalid mode data', () => {
    expect(() => ModeSchema.parse({ id: 'Bad Id', name: '' })).toThrow();
  });
});

describe('maps', () => {
  it('loads the greybox with spawns for both teams', () => {
    const greybox = maps.greybox!;
    expect(new Set(greybox.spawns.map((s) => s.team))).toEqual(new Set([0, 1]));
    for (const kind of ['box', 'ramp', 'stairs']) {
      expect(greybox.geometry.some((g) => g.kind === kind)).toBe(true);
    }
  });

  it('only allows quarter-turn yaw on geometry', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as unknown as {
      geometry: { yawDeg?: number }[];
    };
    map.geometry[0]!.yawDeg = 45;
    expect(MapSchema.safeParse(map).success).toBe(false);
  });

  it('rejects non-positive box sizes', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as unknown as {
      geometry: { size?: number[] }[];
    };
    map.geometry[0]!.size = [1, 0, 1];
    expect(MapSchema.safeParse(map).success).toBe(false);
  });
});

describe.each(['relay-yard', 'saltline-depot'])('%s', (id) => {
  it('is point-symmetric: rotated 180° it is the same map with the teams swapped (fair)', () => {
    const m = maps[id]!;
    const near = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);
    const flip = (p: readonly number[]) => [-p[0]! + 0, p[1]!, -p[2]! + 0];
    const turn = (yaw: number) => (yaw + 180) % 360;
    for (const g of m.geometry) {
      const twin = m.geometry.find((o) => {
        if (o.kind !== g.kind) return false;
        if (g.kind === 'box' && o.kind === 'box')
          return near(o.center, flip(g.center)) && near(o.size, g.size);
        if (g.kind === 'ramp' && o.kind === 'ramp') {
          return (
            near(o.base, flip(g.base)) &&
            o.yawDeg === turn(g.yawDeg) &&
            o.run === g.run &&
            o.rise === g.rise
          );
        }
        if (g.kind === 'stairs' && o.kind === 'stairs') {
          return near(o.start, flip(g.start)) && o.yawDeg === turn(g.yawDeg) && o.steps === g.steps;
        }
        return false;
      });
      expect(twin, JSON.stringify(g)).toBeDefined();
    }
    for (const s of m.spawns) {
      const twin = m.spawns.find((o) => o.team !== s.team && near(o.position, flip(s.position)));
      expect(twin, JSON.stringify(s)).toBeDefined();
    }
  });

  it('has six spawns per team for 6v6', () => {
    const m = maps[id]!;
    expect(m.spawns.filter((s) => s.team === 0)).toHaveLength(6);
    expect(m.spawns.filter((s) => s.team === 1)).toHaveLength(6);
  });
});

describe('map rotation', () => {
  it('only lists real maps, with at least two', () => {
    expect(MAP_ROTATION.length).toBeGreaterThanOrEqual(2);
    for (const id of MAP_ROTATION) expect(maps[id], id).toBeDefined();
  });
});

describe('map validation', () => {
  it('requires a spawn for each team', () => {
    const map = JSON.parse(JSON.stringify(maps.greybox)) as { spawns: { team: number }[] };
    map.spawns = map.spawns.filter((s) => s.team === 0);
    map.spawns.push({ ...map.spawns[0]! });
    expect(MapSchema.safeParse(map).success).toBe(false);
  });
});

describe('movement tuning', () => {
  it('uses the approved starting numbers', () => {
    expect(movement.walkSpeed).toBe(5);
    expect(movement.sprintSpeed).toBe(7.5);
    expect(movement.crouchSpeed).toBe(2.5);
    expect(movement.jumpHeight).toBe(1.1);
    expect(movement.slideDuration).toBe(0.8);
  });

  it('caps slide timers so they fit the u8 wire field', () => {
    expect(MovementSchema.safeParse({ ...movement, slideDuration: 5 }).success).toBe(false);
    expect(MovementSchema.safeParse({ ...movement, slideCooldown: 5 }).success).toBe(false);
  });

  it('rejects speeds in the wrong order', () => {
    expect(MovementSchema.safeParse({ ...movement, crouchSpeed: 9 }).success).toBe(false);
  });
});

describe('weapons', () => {
  it('has an original rifle and sidearm in the default loadout', () => {
    expect(defaultLoadout.map((w) => [w.class, w.slot])).toEqual([
      ['rifle', 0],
      ['sidearm', 1],
    ]);
  });

  it('kills in 4–5 rifle body shots, about 0.3–0.5 s (GAME_DESIGN medium-fast TTK)', () => {
    const rifle = weapons['kestrel-ar']!;
    const shots = Math.ceil(100 / rifle.damage.torso);
    expect(shots).toBeGreaterThanOrEqual(4);
    expect(shots).toBeLessThanOrEqual(5);
    const ttk = ((shots - 1) * 60) / rifle.rpm;
    expect(ttk).toBeGreaterThanOrEqual(0.3);
    expect(ttk).toBeLessThanOrEqual(0.5);
  });

  it('rejects bad weapon data', () => {
    const rifle = weapons['kestrel-ar']!;
    expect(WeaponSchema.safeParse({ ...rifle, rpm: 5000 }).success).toBe(false);
    expect(
      WeaponSchema.safeParse({ ...rifle, damage: { head: 10, torso: 20, limbs: 5 } }).success,
    ).toBe(false);
    expect(
      WeaponSchema.safeParse({ ...rifle, falloff: { start: 30, end: 20, minMultiplier: 1 } })
        .success,
    ).toBe(false);
    expect(WeaponSchema.safeParse({ ...rifle, magazine: 300 }).success).toBe(false);
  });

  it('registers every weapon JSON file (run `pnpm --filter @sentinel/content gen` if not)', () => {
    const onDisk = Object.keys(import.meta.glob('./weapons/*.json'))
      .map((f) => f.replace('./weapons/', ''))
      .sort();
    expect(weaponFileNames).toEqual(onDisk);
  });

  it('has one weapon per class: rifle, SMG, shotgun, marksman, sidearm', () => {
    expect(new Set(weaponCatalog.map((w) => w.class))).toEqual(
      new Set(['rifle', 'smg', 'shotgun', 'marksman', 'sidearm']),
    );
    expect(weaponCatalog.length).toBeLessThan(KILL_SOURCE_FRAG); // u8 wire codes stay distinct
  });

  it('gives each weapon a stable wire index sorted by id', () => {
    const ids = weaponCatalog.map((w) => w.id);
    expect(ids).toEqual([...ids].sort());
    expect(weaponIndex('kestrel-ar')).toBe(ids.indexOf('kestrel-ar'));
    expect(weaponIndex('nope')).toBe(-1);
  });

  it('keeps every weapon id matching its file name', () => {
    expect(weaponCatalog.map((w) => `${w.id}.json`)).toEqual(weaponFileNames);
  });

  it('never lets a loadout put a weapon in the wrong slot', () => {
    expect(resolveLoadout('vireo-smg', 'wren-sp').map((w) => w.id)).toEqual([
      'vireo-smg',
      'wren-sp',
    ]);
    expect(resolveLoadout('wren-sp', 'kestrel-ar').map((w) => w.id)).toEqual([
      'kestrel-ar',
      'wren-sp',
    ]);
    expect(resolveLoadout(42, { x: 1 }).map((w) => w.id)).toEqual(['kestrel-ar', 'wren-sp']);
    for (const junk of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveLoadout(junk, junk).map((w) => w.id)).toEqual(['kestrel-ar', 'wren-sp']);
    }
  });

  it('makes the shotgun a close-range one-shot only when most pellets land', () => {
    const sg = weapons['thresher-12']!;
    expect(sg.pellets).toBeGreaterThan(1);
    expect(sg.pellets * sg.damage.torso).toBeGreaterThanOrEqual(100);
    expect(Math.ceil(sg.pellets / 2) * sg.damage.torso).toBeLessThan(100);
  });

  it('keeps every automatic primary at 4–7 body shots to kill', () => {
    for (const w of weaponCatalog.filter((w) => w.fireMode === 'auto')) {
      const shots = Math.ceil(100 / w.damage.torso);
      expect(shots, w.id).toBeGreaterThanOrEqual(4);
      expect(shots, w.id).toBeLessThanOrEqual(7);
    }
  });
});

describe('content hash', () => {
  it('is an 8-digit hex fingerprint', async () => {
    const { CONTENT_HASH } = await import('./index.ts');
    expect(CONTENT_HASH).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('equipment', () => {
  it('has a frag that kills up close but not from the edge of its radius', () => {
    const e = equipment.frag.explosion!;
    expect(e.maxDamage).toBeGreaterThanOrEqual(100);
    expect(e.minDamage).toBeLessThan(50);
    expect(equipment.frag.kind).toBe('frag');
    expect(equipment.smoke.smoke?.duration).toBeGreaterThan(5);
  });

  it('rejects a frag without an explosion and a smoke without a cloud', () => {
    expect(EquipmentSchema.safeParse({ ...equipment.frag, explosion: undefined }).success).toBe(
      false,
    );
    expect(EquipmentSchema.safeParse({ ...equipment.smoke, smoke: undefined }).success).toBe(false);
  });

  it('names kill sources for the kill feed', () => {
    expect(killSourceName(KILL_SOURCE_FRAG)).toBe('Frag grenade');
    expect(killSourceName(weaponCatalog.findIndex((w) => w.id === 'vireo-smg'))).toBe('Vireo SMG');
    expect(killSourceName(255)).toBe('');
  });
});

describe('attachments and perks', () => {
  it('load from data, every attachment fits at least one primary', () => {
    expect(attachmentCatalog.length).toBeGreaterThanOrEqual(8);
    expect(perkCatalog.length).toBeGreaterThanOrEqual(4);
    for (const a of attachmentCatalog) {
      expect(
        weaponCatalog.some((w) => w.slot === 0 && a.classes.includes(w.class)),
        a.id,
      ).toBe(true);
    }
  });

  it('modifies weapon numbers: extended mag, compensator, quick hands', () => {
    const base = weapons['kestrel-ar']!;
    const l = buildLoadout({
      primary: 'kestrel-ar',
      attachments: ['extended-mag', 'compensator'],
      perks: ['quick-hands'],
    });
    const w = l.weapons[0];
    expect(w.magazine).toBe(Math.round(base.magazine * 1.3));
    expect(w.recoil.pattern[0]![0]).toBeCloseTo(base.recoil.pattern[0]![0] * 0.82);
    expect(w.reloadTime).toBeCloseTo(base.reloadTime * 1.12 * 0.8);
    // Perks also apply to the sidearm; attachments don't.
    expect(l.weapons[1].reloadTime).toBeCloseTo(weapons['wren-sp']!.reloadTime * 0.8);
    expect(l.weapons[1].recoil).toEqual(weapons['wren-sp']!.recoil);
  });

  it('drops invalid picks: wrong class, second of a slot, too many, unknown, repeats', () => {
    const l = buildLoadout({
      primary: 'thresher-12',
      attachments: [
        'compensator',
        'reflex-sight',
        'tactical-scope',
        'fast-mag',
        'vertical-grip',
        'x',
      ],
      perks: ['light-step', 'light-step', 'nope', 'flak-vest', 'quick-hands', 'deep-pockets'],
    });
    // compensator doesn't fit shotguns; tactical scope is a second optic; the 4th is over max.
    expect(l.choice.attachments).toEqual(['reflex-sight', 'fast-mag', 'vertical-grip']);
    // Kept in canonical (catalog) order, whatever order they were picked in.
    expect(l.choice.perks).toEqual(['flak-vest', 'light-step', 'quick-hands']);
  });

  it('with nothing picked, the weapons are the plain data', () => {
    expect(buildLoadout({}).weapons).toEqual(defaultLoadout);
    expect(applyModifiers(weapons['vireo-smg']!, [])).toBe(weapons['vireo-smg']);
  });

  it('round-trips through wire indices', () => {
    const l = buildLoadout({
      primary: 'halberd-mr',
      attachments: ['tactical-scope', 'heavy-stock'],
      perks: ['deep-pockets'],
    });
    const back = loadoutFromWire(loadoutToWire(l));
    expect(back.choice).toEqual(l.choice);
    expect(back.weapons).toEqual(l.weapons);
  });

  it('deep pockets adds a spare magazine', () => {
    const l = buildLoadout({ perks: ['deep-pockets'] });
    expect(l.weapons[0].reserve).toBe(defaultLoadout[0].reserve + defaultLoadout[0].magazine);
  });
});

describe('loadout building is safe for every combination', () => {
  const powerset = <T>(xs: readonly T[], max: number): T[][] =>
    xs.reduce<T[][]>(
      (sets, x) => [...sets, ...sets.filter((s) => s.length < max).map((s) => [...s, x])],
      [[]],
    );

  it('every weapon × attachment set × perk set gives valid data within wire limits', () => {
    const perkSets = powerset(
      perkCatalog.map((p) => p.id),
      MAX_PERKS,
    );
    let checked = 0;
    for (const w of weaponCatalog.filter((x) => x.slot === 0)) {
      const fits = attachmentCatalog.filter((a) => a.classes.includes(w.class)).map((a) => a.id);
      for (const attachments of powerset(fits, MAX_ATTACHMENTS)) {
        for (const perks of perkSets) {
          const l = buildLoadout({ primary: w.id, attachments, perks });
          for (const built of l.weapons) {
            // Tick fields on the wire are u8: every time must stay ≤ 4.25 s.
            expect(built.reloadTime).toBeLessThanOrEqual(4.25);
            expect(built.adsTime).toBeLessThanOrEqual(4.25);
            expect(built.equipTime).toBeLessThanOrEqual(4.25);
            expect(built.magazine).toBeLessThanOrEqual(255);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('the order of picks never changes the weapons (canonical order)', () => {
    const a = buildLoadout({
      primary: 'kestrel-ar',
      attachments: ['light-stock', 'compensator', 'reflex-sight'],
      perks: ['steady-hands', 'light-step', 'quick-hands'],
    });
    const b = buildLoadout({
      primary: 'kestrel-ar',
      attachments: ['reflex-sight', 'light-stock', 'compensator'],
      perks: ['quick-hands', 'steady-hands', 'light-step'],
    });
    expect(b.weapons).toEqual(a.weapons);
    expect(b.choice).toEqual(a.choice);
  });

  it('reads only a few entries from huge untrusted arrays', () => {
    const huge = Array.from({ length: 100_000 }, () => 'reflex-sight');
    expect(buildLoadout({ attachments: huge, perks: huge }).choice.attachments).toEqual([
      'reflex-sight',
    ]);
  });
});

describe('progression (data)', () => {
  it('unlock tables only name real weapons, perks and attachments', () => {
    for (const row of progression.accountUnlocks) {
      for (const id of row.weapons) expect(weapons[id], id).toBeDefined();
      for (const id of row.perks)
        expect(
          perkCatalog.some((p) => p.id === id),
          id,
        ).toBe(true);
    }
    for (const row of progression.weaponLevels.attachmentUnlocks) {
      for (const id of row.attachments)
        expect(
          attachmentCatalog.some((a) => a.id === id),
          id,
        ).toBe(true);
    }
  });

  it('a new player has the default loadout available and some things locked', () => {
    expect(hasWeapon(NEW_PLAYER, 'kestrel-ar')).toBe(true);
    expect(hasWeapon(NEW_PLAYER, 'wren-sp')).toBe(true);
    expect(hasWeapon(NEW_PLAYER, 'thresher-12')).toBe(false);
    const l = buildLoadout(
      {
        primary: 'thresher-12',
        attachments: ['extended-mag', 'compensator'],
        perks: ['light-step', 'flak-vest'],
      },
      NEW_PLAYER,
    );
    expect(l.choice).toEqual({
      primary: 'kestrel-ar', // shotgun locked → default
      secondary: 'wren-sp',
      attachments: ['extended-mag'], // compensator needs weapon level 4
      perks: ['light-step'], // flak vest needs account level 8
    });
  });

  it('levels and weapon kills unlock things; unlockAll unlocks everything', () => {
    const vet = { level: 10, weaponKills: { 'kestrel-ar': 100 } };
    expect(hasWeapon(vet, 'halberd-mr')).toBe(true);
    expect(hasAttachment(vet, 'kestrel-ar', 'heavy-stock')).toBe(true);
    expect(hasAttachment(vet, 'vireo-smg', 'heavy-stock')).toBe(false); // per weapon
    expect(hasPerk({ ...NEW_PLAYER, unlockAll: true }, 'deep-pockets')).toBe(true);
  });

  it('weapon levels follow the kill table', () => {
    expect(weaponLevelFor(0)).toBe(1);
    expect(weaponLevelFor(9)).toBe(1);
    expect(weaponLevelFor(10)).toBe(2);
    expect(weaponLevelFor(1e6)).toBe(MAX_WEAPON_LEVEL);
  });

  it('XP breakdown adds up and matches the level curve', () => {
    const lines = xpBreakdown({ team: 0, kills: 3, headshots: 1 }, 0);
    expect(lines.map((l) => l.label)).toEqual([
      'Match played',
      'Kills × 3',
      'Headshots × 1',
      'Victory',
    ]);
    expect(xpForMatch({ team: 0, kills: 3, headshots: 1 }, 0)).toBe(150 + 300 + 25 + 250);
    expect(levelFor(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 500 });
    expect(levelFor(500 + 750 + 10).level).toBe(3);
  });
});

describe('challenges (data)', () => {
  const day = 86_400_000;
  const monday = Date.UTC(2026, 8, 21); // Monday 21 Sep 2026

  it('only name real weapons, ids are unique', () => {
    const all = [...challengeData.daily, ...challengeData.weekly];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) if (c.weapon) expect(weapons[c.weapon], c.id).toBeDefined();
  });

  it('are the same for everyone at a given time, change daily / weekly', () => {
    const a = activeChallenges(monday + 3_600_000);
    expect(activeChallenges(monday + 7_200_000)).toEqual(a);
    expect(a.filter((c) => c.period === 'daily')).toHaveLength(challengeData.dailyCount);
    expect(a.filter((c) => c.period === 'weekly')).toHaveLength(challengeData.weeklyCount);
    const tomorrow = activeChallenges(monday + day + 1);
    expect(tomorrow.filter((c) => c.period === 'daily').map((c) => c.id)).not.toEqual(
      a.filter((c) => c.period === 'daily').map((c) => c.id),
    );
    // Same week until Monday.
    const sunday = activeChallenges(monday + 6 * day + 1);
    expect(sunday.filter((c) => c.period === 'weekly')).toEqual(
      a.filter((c) => c.period === 'weekly'),
    );
    const nextMonday = activeChallenges(monday + 7 * day + 1);
    expect(nextMonday.find((c) => c.period === 'weekly')!.periodId).toBe(
      a.find((c) => c.period === 'weekly')!.periodId + 1,
    );
  });

  it('progress counts the right stat from a match', () => {
    const m = {
      kills: 9,
      headshots: 3,
      fragKills: 1,
      won: true,
      weaponKills: { 'vireo-smg': 4 },
    };
    const find = (id: string) =>
      [...challengeData.daily, ...challengeData.weekly].find((c) => c.id === id)!;
    expect(challengeProgress(find('d-kills-15'), m)).toBe(9);
    expect(challengeProgress(find('d-smg-10'), m)).toBe(4);
    expect(challengeProgress(find('d-rifle-12'), m)).toBe(0);
    expect(challengeProgress(find('d-wins-2'), m)).toBe(1);
    expect(challengeProgress(find('d-matches-3'), m)).toBe(1);
    expect(challengeProgress(find('d-headshots-5'), m)).toBe(3);
  });
});
