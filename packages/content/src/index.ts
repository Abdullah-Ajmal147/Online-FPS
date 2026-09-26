import {
  EquipmentSchema,
  MapSchema,
  ModeSchema,
  MovementSchema,
  type Equipment,
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

/**
 * Fingerprint of all gameplay content (FNV-1a over the parsed data). Weapons travel as catalog
 * indices and both sides simulate with these numbers, so a client built from different content
 * than the server would predict wrongly; the server refuses such joins like a protocol mismatch.
 */
export const CONTENT_HASH: string = (() => {
  const text = JSON.stringify([weaponCatalog, equipment, movement]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
})();
