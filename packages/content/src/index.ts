import {
  AttachmentSchema,
  EquipmentSchema,
  PerkSchema,
  MapSchema,
  ModeSchema,
  MovementSchema,
  type Attachment,
  type Equipment,
  type Perk,
  type StatModifiers,
  type GameMap,
  type Mode,
  type Movement,
  type Weapon,
  WeaponSchema,
} from './schemas.ts';
import teamDeathmatchJson from './modes/team-deathmatch.json' with { type: 'json' };
import arenaJson from './maps/arena.json' with { type: 'json' };
import greyboxJson from './maps/greybox.json' with { type: 'json' };
import relayYardJson from './maps/relay-yard.json' with { type: 'json' };
import saltlineDepotJson from './maps/saltline-depot.json' with { type: 'json' };
import movementJson from './movement.json' with { type: 'json' };
import attachmentsJson from './attachments.json' with { type: 'json' };
import perksJson from './perks.json' with { type: 'json' };
import fragJson from './equipment/frag.json' with { type: 'json' };
import smokeJson from './equipment/smoke.json' with { type: 'json' };
import { weaponFiles } from './weapons/catalog.gen.ts';

export * from './schemas.ts';

/** All content is validated at load time; a bad file fails fast on both client and server. */
export const modes: Record<string, Mode> = {
  'team-deathmatch': ModeSchema.parse(teamDeathmatchJson),
};

export const maps: Record<string, GameMap> = {
  greybox: MapSchema.parse(greyboxJson),
  /** First real map: compact, original, three lanes (Phase 3). */
  'relay-yard': MapSchema.parse(relayYardJson),
  /** Second real map (Phase 5): dusk shipping depot, central platform, flank warehouses. */
  'saltline-depot': MapSchema.parse(saltlineDepotJson),
  /** Open test arena with a clear line between spawns (netcode and hit-registration tests). */
  arena: MapSchema.parse(arenaJson),
};

/** Maps played in turn when the server isn't pinned to one (SENTINEL_MAP). */
export const MAP_ROTATION: readonly string[] = ['relay-yard', 'saltline-depot'];

export const movement: Movement = MovementSchema.parse(movementJson);

/**
 * Every weapon, sorted by id. A weapon's index here is how it travels on the wire (u8), so
 * client and server must run the same content build (PROTOCOL_VERSION guards the handshake).
 * Adding a weapon is data only: a JSON file in src/weapons/ + `pnpm --filter @sentinel/content gen`.
 */
export const weaponCatalog: readonly Weapon[] = weaponFiles
  .map((json) => WeaponSchema.parse(json))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export const weapons: Record<string, Weapon> = Object.fromEntries(
  weaponCatalog.map((w) => [w.id, w]),
);

/** Wire index of a weapon id, or -1. */
export function weaponIndex(id: string): number {
  return weaponCatalog.findIndex((w) => w.id === id);
}

/** Default loadout: [primary, secondary]. Players pick their own in the menu (Phase 5). */
export const defaultLoadout: readonly [Weapon, Weapon] = [
  weapons['kestrel-ar']!,
  weapons['wren-sp']!,
];

/**
 * A loadout from untrusted ids (join options, SetLoadout): unknown ids or a weapon in the
 * wrong slot fall back to the default for that slot.
 */
export function resolveLoadout(primary: unknown, secondary: unknown): readonly [Weapon, Weapon] {
  const pick = (id: unknown, slot: 0 | 1): Weapon => {
    const w = typeof id === 'string' && Object.hasOwn(weapons, id) ? weapons[id] : undefined;
    return w && w.slot === slot ? w : defaultLoadout[slot];
  };
  return [pick(primary, 0), pick(secondary, 1)];
}

/** Thrown equipment. Every player carries both (loadout choice comes with perks, Phase 6). */
export const equipment = {
  frag: EquipmentSchema.parse(fragJson),
  smoke: EquipmentSchema.parse(smokeJson),
} as const satisfies Record<string, Equipment>;

/**
 * Kill-feed "weapon" codes on the wire (u8): weapon catalog index, or one of these.
 * 255 = no weapon (a fall).
 */
export const KILL_SOURCE_FRAG = 200;

/** Name to show in the kill feed for a kill source code. */
export function killSourceName(code: number): string {
  if (code === KILL_SOURCE_FRAG) return equipment.frag.name;
  return weaponCatalog[code]?.name ?? '';
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Weapon attachments, sorted by id (index = wire index). */
export const attachmentCatalog: readonly Attachment[] = (attachmentsJson as unknown[])
  .map((a) => AttachmentSchema.parse(a))
  .sort(byId);

/** Perks, sorted by id (index = wire index). */
export const perkCatalog: readonly Perk[] = (perksJson as unknown[])
  .map((p) => PerkSchema.parse(p))
  .sort(byId);

export const MAX_ATTACHMENTS = 3;
const SLOT_ORDER: readonly Attachment['slot'][] = ['optic', 'barrel', 'magazine', 'grip', 'stock'];
const clampKick = (v: number) => Math.max(-10, Math.min(10, v));
export const MAX_PERKS = 3;

/** What a player picked, by id. */
export interface LoadoutChoice {
  primary: string;
  secondary: string;
  /** Primary weapon attachments (one per slot). */
  attachments: string[];
  perks: string[];
}

/** A validated loadout: the chosen ids and the weapons with every modifier applied. */
export interface Loadout {
  choice: LoadoutChoice;
  weapons: readonly [Weapon, Weapon];
  perks: readonly Perk[];
}

/** Weapon stats with modifiers applied (validated again, so limits always hold). */
export function applyModifiers(base: Weapon, mods: readonly StatModifiers[]): Weapon {
  if (mods.length === 0) return base;
  const m = (key: Exclude<keyof StatModifiers, 'reserveMagazines'>) =>
    mods.reduce((f, x) => f * (x[key] ?? 1), 1);
  const extraMags = mods.reduce((n, x) => n + (x.reserveMagazines ?? 0), 0);
  const magazine = Math.max(1, Math.min(255, Math.round(base.magazine * m('magazine'))));
  const range = m('range');
  const speed = m('moveSpeed');
  return WeaponSchema.parse({
    ...base,
    magazine,
    reserve: Math.min(65535, Math.round(base.reserve * m('magazine')) + extraMags * magazine),
    reloadTime: Math.min(4.25, base.reloadTime * m('reloadTime')),
    equipTime: Math.min(4.25, base.equipTime * m('equipTime')),
    adsTime: Math.min(4.25, base.adsTime * m('adsTime')),
    falloff: {
      ...base.falloff,
      start: base.falloff.start * range,
      end: base.falloff.end * range,
    },
    maxRange: Math.min(500, base.maxRange * range),
    spread: {
      ...base.spread,
      hip: Math.min(45, base.spread.hip * m('spreadHip')),
      moving: Math.min(45, base.spread.moving * m('spreadMoving')),
    },
    recoil: {
      ...base.recoil,
      // Clamped to the schema's ±10° so no modifier combination can make invalid data.
      pattern: base.recoil.pattern.map(([up, right]) => [
        clampKick(up * m('recoil')),
        clampKick(right * m('recoil')),
      ]),
    },
    moveSpeedMultiplier: Math.min(1.5, base.moveSpeedMultiplier * speed),
    adsMoveSpeedMultiplier: Math.min(1.5, base.adsMoveSpeedMultiplier * speed),
  });
}

/**
 * Build a loadout from untrusted input (join options, menu settings, the wire): unknown or
 * misfitting weapons fall back to the default, attachments must fit the primary (one per
 * slot, at most 3), perks must exist (no repeats, at most 3). Invalid picks are dropped.
 */
export function buildLoadout(raw: {
  primary?: unknown;
  secondary?: unknown;
  attachments?: unknown;
  perks?: unknown;
}): Loadout {
  const [primary, secondary] = resolveLoadout(raw.primary, raw.secondary);
  // At most a few entries are read from untrusted arrays (join options can be large).
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.slice(0, 16).filter((x): x is string => typeof x === 'string') : [];
  const attachments: Attachment[] = [];
  for (const id of ids(raw.attachments)) {
    const a = attachmentCatalog.find((x) => x.id === id);
    if (!a || !a.classes.includes(primary.class)) continue;
    if (attachments.some((x) => x.slot === a.slot) || attachments.length >= MAX_ATTACHMENTS)
      continue;
    attachments.push(a);
  }
  const perks: Perk[] = [];
  for (const id of ids(raw.perks)) {
    const p = perkCatalog.find((x) => x.id === id);
    if (!p || perks.includes(p) || perks.length >= MAX_PERKS) continue;
    perks.push(p);
  }
  // Canonical order (slot order, catalog order): the float products in applyModifiers then
  // never depend on the order the player clicked, so every builder gets identical numbers.
  attachments.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  perks.sort((a, b) => perkCatalog.indexOf(a) - perkCatalog.indexOf(b));
  const perkMods = perks.map((p) => p.modifiers);
  return {
    choice: {
      primary: primary.id,
      secondary: secondary.id,
      attachments: attachments.map((a) => a.id),
      perks: perks.map((p) => p.id),
    },
    weapons: [
      applyModifiers(primary, [...attachments.map((a) => a.modifiers), ...perkMods]),
      applyModifiers(secondary, perkMods),
    ],
    perks,
  };
}

/** The default loadout (no attachments, no perks). */
export const defaultBuiltLoadout: Loadout = buildLoadout({});

/** Loadout as catalog indices for the wire (SetLoadout, own snapshot). */
export interface LoadoutWire {
  primary: number;
  secondary: number;
  attachments: number[];
  perks: number[];
}

export function loadoutToWire(l: Loadout): LoadoutWire {
  return {
    primary: weaponIndex(l.choice.primary),
    secondary: weaponIndex(l.choice.secondary),
    attachments: l.choice.attachments.map((id) => attachmentCatalog.findIndex((a) => a.id === id)),
    perks: l.choice.perks.map((id) => perkCatalog.findIndex((p) => p.id === id)),
  };
}

/** From wire indices; unknown indices are dropped (then the usual validation applies). */
export function loadoutFromWire(w: LoadoutWire): Loadout {
  return buildLoadout({
    primary: weaponCatalog[w.primary]?.id,
    secondary: weaponCatalog[w.secondary]?.id,
    attachments: w.attachments.map((i) => attachmentCatalog[i]?.id),
    perks: w.perks.map((i) => perkCatalog[i]?.id),
  });
}

/**
 * Fingerprint of all gameplay content: maps, weapons, equipment, movement, attachments, perks
 * (FNV-1a over the parsed data). Weapons travel as catalog
 * indices and both sides simulate with these numbers, so a client built from different content
 * than the server would predict wrongly; the server refuses such joins like a protocol mismatch.
 */
export const CONTENT_HASH: string = (() => {
  const text = JSON.stringify([
    maps,
    weaponCatalog,
    equipment,
    movement,
    attachmentCatalog,
    perkCatalog,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
})();
