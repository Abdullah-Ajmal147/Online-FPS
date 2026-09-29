import { describe, expect, it } from 'vitest';
import { defaultLoadout, weapons } from '@sentinel/content';
import { Button, type PlayerInput } from '../input.ts';
import {
  UNITS_PER_DEGREE,
  compileWeapon,
  createWeaponState,
  currentSpread,
  scopeSway,
  stepWeapon,
  weaponSpeedScale,
  type MoveInfo,
  type WeaponState,
} from './weapon.ts';

const loadout = [compileWeapon(defaultLoadout[0]), compileWeapon(defaultLoadout[1])] as const;
const [rifle, pistol] = loadout;
const still: MoveInfo = { moving: false, airborne: false, sprinting: false };

function run(
  ticks: number,
  buttons: number,
  start?: WeaponState,
  move = still,
  extra: Partial<PlayerInput> = {},
) {
  let state = start ?? createWeaponState(loadout);
  let prevButtons = 0;
  let shots = 0;
  for (let i = 0; i < ticks; i++) {
    const r = stepWeapon(
      state,
      { buttons, yaw: 0, pitch: 0, ...extra },
      prevButtons,
      loadout,
      move,
    );
    state = r.state;
    if (r.shot) shots++;
    prevButtons = buttons;
  }
  return { state, shots };
}

describe('weapon data compiles to ticks', () => {
  it('600 rpm rifle fires every 6 ticks; 400 rpm sidearm every 9', () => {
    expect(rifle.fireIntervalTicks).toBe(6);
    expect(pistol.fireIntervalTicks).toBe(9);
  });
});

describe('firing', () => {
  it('auto rifle fires at exactly its rate while held (1 s → 10 shots)', () => {
    expect(run(60, Button.Fire).shots).toBe(10);
  });

  it('semi-auto sidearm fires once per press, holding does not repeat', () => {
    const start = { ...createWeaponState(loadout), slot: 1 as const };
    expect(run(60, Button.Fire, start, still, { weaponSlot: 1 }).shots).toBe(1);
  });

  it('spends ammo and stops at an empty magazine', () => {
    const { state, shots } = run(60 * 4, Button.Fire);
    expect(shots).toBe(30);
    expect(state.ammo[0].ammo).toBe(0);
  });

  it('cannot fire while sprinting', () => {
    expect(run(30, Button.Fire, undefined, { ...still, sprinting: true }).shots).toBe(0);
  });
});

describe('reloading', () => {
  it('auto-reloads when firing on empty and refills from reserve after the reload time', () => {
    let { state } = run(60 * 4, Button.Fire); // empty
    expect(state.reloadTicks).toBeGreaterThan(0); // triggered by trying to fire empty
    ({ state } = run(rifle.reloadTicks, 0, state));
    expect(state.ammo[0]).toEqual({ ammo: 30, reserve: 90 });
  });

  it('manual reload tops up only what is missing', () => {
    let { state } = run(30, Button.Fire); // 5 shots
    expect(state.ammo[0].ammo).toBe(25);
    ({ state } = run(1, Button.Reload, state));
    ({ state } = run(rifle.reloadTicks + 1, 0, state));
    expect(state.ammo[0]).toEqual({ ammo: 30, reserve: 115 });
  });

  it('cannot fire while reloading', () => {
    let { state } = run(12, Button.Fire);
    ({ state } = run(1, Button.Reload, state));
    expect(run(rifle.reloadTicks - 2, Button.Fire, state).shots).toBe(0);
  });
});

describe('switching', () => {
  it('takes the equip time before the new weapon can fire, and cancels a reload', () => {
    let { state } = run(12, Button.Fire);
    ({ state } = run(1, Button.Reload, state));
    ({ state } = run(1, 0, state, still, { weaponSlot: 1 }));
    expect(state.slot).toBe(1);
    expect(state.reloadTicks).toBe(0);
    expect(run(pistol.equipTicks - 2, Button.Fire, state, still, { weaponSlot: 1 }).shots).toBe(0);
  });

  it('ignores slots that do not exist', () => {
    const { state } = run(3, 0, undefined, still, { weaponSlot: 7 });
    expect(state.slot).toBe(0);
  });
});

describe('aiming, spread and recoil', () => {
  it('aiming takes the ADS time and tightens spread and slows movement', () => {
    const hip = createWeaponState(loadout);
    const { state } = run(rifle.adsTicks, Button.Aim);
    expect(state.adsTicks).toBe(rifle.adsTicks);
    expect(currentSpread(state, rifle, still)).toBeLessThan(currentSpread(hip, rifle, still));
    expect(weaponSpeedScale(state, rifle)).toBeCloseTo(defaultLoadout[0].adsMoveSpeedMultiplier, 6);
  });

  it('bloom from sustained fire is mostly suppressed while aiming down sights', () => {
    const hipSpray = run(30, Button.Fire).state;
    const adsSpray = run(30, Button.Fire | Button.Aim, run(rifle.adsTicks, Button.Aim).state).state;
    const hipExtra = currentSpread(hipSpray, rifle, still) - rifle.spread.hip;
    const adsExtra = currentSpread(adsSpray, rifle, still) - rifle.spread.ads;
    expect(hipExtra).toBeGreaterThan(0);
    expect(adsExtra).toBeLessThanOrEqual(Math.ceil(hipExtra * 0.15) + 1);
  });

  it('moving and jumping widen spread', () => {
    const s = createWeaponState(loadout);
    expect(currentSpread(s, rifle, { ...still, moving: true })).toBeGreaterThan(
      currentSpread(s, rifle, still),
    );
    expect(currentSpread(s, rifle, { ...still, airborne: true })).toBeGreaterThan(
      currentSpread(s, rifle, still),
    );
  });

  it('a full-magazine spray climbs, but stays controllable (< 2°), and settles back after', () => {
    const { state: full } = run(170, Button.Fire); // 29 shots: just before the magazine runs dry
    expect(full.recoilPitch).toBeGreaterThan(0.3 * UNITS_PER_DEGREE);
    expect(full.recoilPitch).toBeLessThan(2 * UNITS_PER_DEGREE);
    const { state } = run(30, Button.Fire);
    expect(state.recoilPitch).toBeGreaterThan(0);
    const settled = run(120, 0, state).state;
    expect(settled.recoilPitch).toBe(0);
    expect(settled.recoilYaw).toBe(0);
    expect(settled.shotIndex).toBe(0);
  });

  it('the first shot goes exactly where you look (no recoil yet)', () => {
    const r = stepWeapon(
      createWeaponState(loadout),
      { buttons: Button.Fire, yaw: 1234, pitch: -500 },
      0,
      loadout,
      still,
    );
    expect(r.shot).toMatchObject({ yaw: 1234, pitch: -500, slot: 0 });
  });
});

describe('scope sway and holding the breath', () => {
  const halberd = compileWeapon(weapons['halberd-mr']!);
  const scoped = [halberd, pistol] as const;
  const aim = (ticks: number, buttons = Button.Aim, start?: WeaponState) => {
    let state = start ?? createWeaponState(scoped);
    let prevButtons = 0;
    const path: [number, number][] = [];
    for (let i = 0; i < ticks; i++) {
      state = stepWeapon(state, { buttons, yaw: 0, pitch: 0 }, prevButtons, scoped, still).state;
      prevButtons = buttons;
      path.push(scopeSway(state, halberd));
    }
    return { state, path };
  };
  const widest = (path: [number, number][]) => Math.max(...path.map(([y]) => Math.abs(y)));

  it('drifts only when fully aimed through a scope, and never for other weapons', () => {
    const { path } = aim(400);
    expect(path[halberd.adsTicks - 2]).toEqual([0, 0]); // still raising the rifle
    expect(widest(path)).toBeGreaterThan(halberd.scope!.sway * 0.8);
    expect(widest(path)).toBeLessThanOrEqual(halberd.scope!.sway);
    expect(scopeSway(run(60, Button.Aim).state, rifle)).toEqual([0, 0]);
  });

  it('the shot goes where the drifting scope points', () => {
    const { state } = aim(100);
    const [yaw, pitch] = scopeSway(
      { ...state, scopeTicks: state.scopeTicks + 1, swayPct: state.swayPct },
      halberd,
    );
    const r = stepWeapon(
      state,
      { buttons: Button.Aim | Button.Fire, yaw: 0, pitch: 0 },
      Button.Aim,
      scoped,
      still,
    );
    expect(r.shot).toMatchObject({ yaw: yaw & 0xffff, pitch });
  });

  it('holding the breath (sprint while aimed) steadies it, then it runs out and sways more', () => {
    const settled = aim(120).state;
    const held = aim(60, Button.Aim | Button.Sprint, settled);
    expect(held.state.swayPct).toBe(10);
    expect(widest(held.path.slice(20))).toBeLessThan(halberd.scope!.sway * 0.2);
    // Past the hold time: forced to breathe, wider sway for a while.
    const out = aim(halberd.scope!.holdTicks, Button.Aim | Button.Sprint, held.state);
    expect(out.state.recoverTicks).toBeGreaterThan(0);
    expect(out.state.swayPct).toBeGreaterThan(100);
    // Recovered: normal again.
    const after = aim(halberd.scope!.recoverTicks + 60, Button.Aim, out.state);
    expect(after.state.swayPct).toBe(100);
  });
});

describe('prone steadiness', () => {
  it('scales spread and recoil by the stance', () => {
    const prone: MoveInfo = { ...still, steadyPct: { spread: 50, recoil: 60 } };
    const s = createWeaponState(loadout);
    expect(currentSpread(s, rifle, prone)).toBe(Math.round(currentSpread(s, rifle, still) / 2));
    const kick = (move: MoveInfo) => run(1, Button.Fire, undefined, move).state.recoilPitch;
    expect(kick(prone)).toBe(Math.round((kick(still) * 60) / 100));
  });
});
