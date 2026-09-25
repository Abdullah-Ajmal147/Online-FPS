import { describe, expect, it } from 'vitest';
import { movement as tuning } from '@sentinel/content';
import { Button, KNOWN_BUTTONS, MAX_PITCH } from '../input.ts';
import { createPlayerBody } from './context.ts';
import type { PlayerState } from './state.ts';
import { createSim, flatMap, horizontalSpeed } from './harness.ts';

const { Forward, Back, Left, Jump, Crouch, Sprint } = Button;
const TPS = 60;

describe('ground movement', () => {
  it('rests on the floor with feet at y = 0 and grounded', async () => {
    const sim = await createSim([0, 0.5, 0], { map: flatMap() });
    sim.run(30, {});
    expect(sim.state.grounded).toBe(true);
    expect(sim.state.position[1]).toBeCloseTo(0, 2);
  });

  it('walks, sprints and crouch-walks at the tuned speeds', async () => {
    for (const [buttons, speed] of [
      [Forward, tuning.walkSpeed],
      [Forward | Sprint, tuning.sprintSpeed],
      [Forward | Crouch, tuning.crouchSpeed],
    ] as const) {
      const sim = await createSim([0, 0, 15], { map: flatMap() });
      sim.run(TPS / 2, { buttons }); // accelerate
      expect(horizontalSpeed(sim.state)).toBeCloseTo(speed, 3);
      const z0 = sim.state.position[2];
      sim.run(TPS, { buttons });
      expect(z0 - sim.state.position[2]).toBeCloseTo(speed, 1); // yaw 0 walks towards -Z
    }
  });

  it('only sprints forwards', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS, { buttons: Back | Sprint });
    expect(horizontalSpeed(sim.state)).toBeCloseTo(tuning.walkSpeed, 3);
  });

  it('moves diagonally at the same speed as straight (no diagonal speed boost)', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS, { buttons: Forward | Left });
    expect(horizontalSpeed(sim.state)).toBeCloseTo(tuning.walkSpeed, 3);
  });

  it('moves along the yaw direction: a quarter turn left faces -X', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap(), yaw: 16384 });
    sim.run(TPS, { buttons: Forward, yaw: 16384 });
    expect(sim.state.position[0]).toBeLessThan(-3);
    expect(Math.abs(sim.state.position[2])).toBeLessThan(1e-3);
  });

  it('can walk at a shallow angle (small sideways component is not lost)', async () => {
    const yaw = 200; // ≈ 1.1° left of -Z
    const sim = await createSim([0, 0, 15], { map: flatMap(), yaw });
    sim.run(TPS * 2, { buttons: Forward, yaw });
    expect(sim.state.position[0]).toBeLessThan(-0.1);
  });

  it('stops when input is released (friction)', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS, { buttons: Forward });
    sim.run(TPS / 2, { buttons: 0 });
    expect(horizontalSpeed(sim.state)).toBe(0);
  });

  it('is blocked by walls', async () => {
    const sim = await createSim([0, 0, 0], {
      map: flatMap([
        { kind: 'box', center: [0, 2, -3], size: [10, 4, 1], yawDeg: 0, material: 'wall' },
      ]),
    });
    sim.run(TPS * 2, { buttons: Forward });
    // Wall face at z = -2.5; capsule radius 0.35 keeps the centre in front of it.
    expect(sim.state.position[2]).toBeGreaterThan(-2.5 + tuning.capsuleRadius - 0.05);
  });
});

describe('jumping and falling', () => {
  it('reaches the tuned jump height and lands again', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    let apex = 0;
    sim.run(1, { buttons: Jump });
    for (let i = 0; i < TPS * 2; i++) apex = Math.max(apex, sim.run(1, {}).position[1]);
    expect(apex).toBeGreaterThan(tuning.jumpHeight - 0.05);
    expect(apex).toBeLessThan(tuning.jumpHeight + 0.05);
    expect(sim.state.grounded).toBe(true);
    expect(sim.state.position[1]).toBeCloseTo(0, 2);
  });

  it('does not jump again while jump is held (no auto bunny-hop)', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS * 2, { buttons: Jump }); // one jump, then land while still holding
    expect(sim.state.grounded).toBe(true);
    sim.run(10, { buttons: Jump });
    expect(sim.state.position[1]).toBeCloseTo(0, 2);
  });

  it('has no double jump in the air', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(1, { buttons: Jump });
    sim.run(10, {});
    const vyBefore = sim.state.velocity[1];
    sim.run(1, { buttons: Jump });
    expect(sim.state.velocity[1]).toBeLessThan(vyBefore);
  });

  it('can jump onto the 1 m ledge but cannot walk onto it', async () => {
    // Greybox ledge: 4×1×4 box centred at (-20, 0.5, -20). Approach from +Z.
    const walker = await createSim([-20, 0, -15]);
    walker.run(TPS * 2, { buttons: Forward });
    expect(walker.state.position[1]).toBeCloseTo(0, 2);

    const jumper = await createSim([-20, 0, -15]);
    jumper.run(TPS / 2, { buttons: Forward });
    jumper.run(1, { buttons: Forward | Jump });
    jumper.run(40, { buttons: Forward }); // land on top; the ledge is only 4 m deep
    expect(jumper.state.position[1]).toBeCloseTo(1, 2);
    expect(jumper.state.position[2]).toBeLessThan(-18);
  });

  it('falls with gravity when walking off the platform', async () => {
    const sim = await createSim([12, 3, 12]);
    expect(sim.state.position[1]).toBeCloseTo(3, 2);
    sim.run(TPS * 2, { buttons: Forward }); // platform edge at z = 8
    expect(sim.state.position[1]).toBeCloseTo(0, 2);
    expect(sim.state.grounded).toBe(true);
  });
});

describe('steps, stairs and slopes', () => {
  it('steps up onto the 0.3 m block automatically', async () => {
    // Greybox block: 2×0.3×2 at (-8, 0.15, 5), spans z 4..6. Stop while on top.
    const sim = await createSim([-8, 0, 9]);
    let maxY = 0;
    for (let i = 0; i < 70; i++)
      maxY = Math.max(maxY, sim.run(1, { buttons: Forward }).position[1]);
    expect(maxY).toBeCloseTo(0.3, 2);
  });

  it('steps up exactly the tuned step height (0.4 m) and not 0.45 m', async () => {
    for (const [h, climbs] of [
      [tuning.stepHeight, true],
      [0.45, false],
    ] as const) {
      const sim = await createSim([0, 0, 4], {
        map: flatMap([
          { kind: 'box', center: [0, h / 2, 0], size: [4, h, 2], yawDeg: 0, material: 'prop' },
        ]),
      });
      sim.run(TPS, { buttons: Forward });
      if (climbs) expect(sim.state.position[1]).toBeCloseTo(h, 2);
      else {
        // Did not climb (pressing into the block may lift the feet a couple of cm, no more).
        expect(sim.state.position[1]).toBeLessThan(0.1);
        expect(sim.state.position[2]).toBeGreaterThan(1);
      }
    }
  });

  it('is stopped by the 0.6 m block (above step height)', async () => {
    const sim = await createSim([-12, 0, 9]);
    sim.run(TPS * 2, { buttons: Forward });
    expect(sim.state.position[1]).toBeCloseTo(0, 2);
    expect(sim.state.position[2]).toBeGreaterThan(6);
  });

  it('climbs the stairs to the 3 m platform', async () => {
    // Stairs start at z = 3.2 and climb +Z; yaw 32768 faces +Z.
    const sim = await createSim([12, 0, 1], { yaw: 32768 });
    let minSpeed = Infinity;
    for (let i = 0; i < TPS * 2; i++) {
      sim.run(1, { buttons: Forward, yaw: 32768 });
      if (i > 20) minSpeed = Math.min(minSpeed, horizontalSpeed(sim.state));
    }
    expect(minSpeed).toBeGreaterThan(tuning.walkSpeed * 0.95); // steps don't brake us
    expect(sim.state.position[2]).toBeGreaterThan(9);
    expect(sim.state.position[1]).toBeCloseTo(3, 1);
  });

  it('walks up the 20° ramp to the platform', async () => {
    // Ramp climbs +X from x = -0.2; yaw 49152 faces +X.
    const sim = await createSim([-2, 0, 12], { yaw: 49152 });
    sim.run(TPS * 3, { buttons: Forward, yaw: 49152 });
    expect(sim.state.position[0]).toBeGreaterThan(9);
    expect(sim.state.position[1]).toBeCloseTo(3, 1);
  });

  it('cannot walk up the 50° ramp', async () => {
    // Steep ramp base at (-12, 0, -10) climbing -Z.
    const sim = await createSim([-12, 0, -8]);
    sim.run(TPS * 3, { buttons: Forward });
    expect(sim.state.position[1]).toBeLessThan(0.6);
  });
});

describe('crouch and slide', () => {
  it('slides further than crouch-walking and ends crouched', async () => {
    const slider = await createSim([0, 0, 15], { map: flatMap() });
    slider.run(TPS / 2, { buttons: Forward | Sprint });
    const z0 = slider.state.position[2];
    slider.run(1, { buttons: Forward | Sprint | Crouch });
    expect(slider.state.slideTicks).toBeGreaterThan(0);
    expect(horizontalSpeed(slider.state)).toBeGreaterThan(tuning.sprintSpeed);
    slider.run(Math.round(tuning.slideDuration * TPS), { buttons: Forward | Sprint | Crouch });
    expect(slider.state.slideTicks).toBe(0);
    expect(slider.state.crouching).toBe(true);
    const slid = z0 - slider.state.position[2];
    expect(slid).toBeGreaterThan(tuning.crouchSpeed * tuning.slideDuration * 2);
  });

  it('does not slide from a walk', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS / 2, { buttons: Forward });
    sim.run(1, { buttons: Forward | Crouch });
    expect(sim.state.slideTicks).toBe(0);
  });

  it('jumping cancels a slide and keeps its speed', async () => {
    const sim = await createSim([0, 0, 15], { map: flatMap() });
    sim.run(TPS / 2, { buttons: Forward | Sprint });
    sim.run(5, { buttons: Forward | Sprint | Crouch });
    sim.run(1, { buttons: Forward | Sprint | Crouch | Jump });
    expect(sim.state.slideTicks).toBe(0);
    expect(horizontalSpeed(sim.state)).toBeGreaterThan(tuning.sprintSpeed);
  });

  it('stays crouched under a low roof until there is head room', async () => {
    // Roof bottom at 1.5 m over z in [-2, 2]: too low to stand (1.8 m), fine crouched (1.2 m).
    const sim = await createSim([0, 0, 0], {
      map: flatMap([
        { kind: 'box', center: [0, 2, 0], size: [10, 1, 4], yawDeg: 0, material: 'prop' },
      ]),
    });
    sim.run(5, { buttons: Crouch });
    expect(sim.state.crouching).toBe(true);
    sim.run(5, { buttons: 0 });
    expect(sim.state.crouching).toBe(true); // blocked
    sim.run(TPS * 2, { buttons: Forward }); // crouch-walk out from under the roof
    sim.run(2, { buttons: 0 });
    expect(sim.state.crouching).toBe(false);
  });
});

describe('exploits (netcode review findings)', () => {
  it('crouch spam cannot chain slides faster than sprint, in any direction (H1)', async () => {
    for (const buttons of [Forward | Sprint, Back, 0]) {
      const sim = await createSim([0, 0, 15], { map: flatMap() });
      sim.run(TPS / 2, { buttons: Forward | Sprint });
      const [x0, , z0] = sim.state.position;
      for (let i = 0; i < TPS * 2; i++) sim.run(1, { buttons: buttons | (i % 2 ? Crouch : 0) });
      const [x1, , z1] = sim.state.position;
      const avg = Math.hypot(x1 - x0, z1 - z0) / 2;
      expect(avg).toBeLessThanOrEqual(tuning.sprintSpeed + 1e-3);
    }
  });

  it('cannot slide without sprinting forward (H1)', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(TPS / 2, { buttons: Forward | Sprint });
    sim.run(1, { buttons: Forward | Crouch }); // released sprint
    expect(sim.state.slideTicks).toBe(0);
  });

  it('enforces a cooldown between slides (H1)', async () => {
    const sim = await createSim([0, 0, 15], { map: flatMap() });
    sim.run(TPS / 2, { buttons: Forward | Sprint });
    sim.run(3, { buttons: Forward | Sprint | Crouch });
    sim.run(1, { buttons: Forward | Sprint }); // release: slide ends, cooldown starts
    expect(sim.state.slideCooldownTicks).toBeGreaterThan(0);
    sim.run(1, { buttons: Forward | Sprint | Crouch });
    expect(sim.state.slideTicks).toBe(0);
  });

  it('chained hops after a slide-jump decay to sprint speed (M2)', async () => {
    const sim = await createSim([0, 0, 18], { map: flatMap() });
    sim.run(TPS / 2, { buttons: Forward | Sprint });
    sim.run(5, { buttons: Forward | Sprint | Crouch });
    sim.run(1, { buttons: Forward | Sprint | Crouch | Jump }); // slide-jump keeps speed
    expect(horizontalSpeed(sim.state)).toBeGreaterThan(tuning.sprintSpeed);
    let hops = 0;
    for (let i = 0; i < TPS * 8 && hops < 20; i++) {
      const grounded = sim.state.grounded;
      sim.run(1, { buttons: Forward | Sprint | (grounded ? Jump : 0) });
      if (grounded) {
        hops++;
        sim.run(1, { buttons: Forward | Sprint }); // release so the next press counts
      }
    }
    expect(hops).toBeGreaterThanOrEqual(3);
    expect(horizontalSpeed(sim.state)).toBeLessThanOrEqual(tuning.sprintSpeed + 1e-3);
  });

  it('clamps out-of-range pitch and ignores unknown buttons from the network (M3)', async () => {
    const sim = await createSim([0, 0, 0], { map: flatMap() });
    sim.run(1, { buttons: 0xffff & ~(Jump | Crouch), pitch: 32000 });
    expect(sim.state.pitch).toBe(MAX_PITCH);
    expect(sim.state.prevButtons & ~KNOWN_BUTTONS).toBe(0);
    sim.run(1, { pitch: -32768 });
    expect(sim.state.pitch).toBe(-MAX_PITCH);
    sim.run(1, { pitch: Number.NaN, yaw: 1.7 });
    expect(sim.state.pitch).toBe(0);
    expect(sim.state.yaw).toBe(1);
  });
});

describe('determinism', () => {
  it('gives bit-identical results in two separate worlds', async () => {
    const script = (i: number) => ({
      buttons:
        (i % 90 < 60 ? Forward : 0) |
        (i % 200 > 120 ? Sprint : 0) |
        (i % 150 === 0 ? Jump : 0) |
        (i % 240 > 200 ? Crouch : 0) |
        (i % 300 > 250 ? Left : 0),
      yaw: (i * 97) & 0xffff,
      pitch: 0,
    });
    const a = await createSim([-10, 0, 10]);
    const b = await createSim([-10, 0, 10]);
    for (let i = 0; i < 600; i++) {
      a.run(1, script(i));
      b.run(1, script(i));
    }
    expect(a.state).toEqual(b.state);
  });

  it('resumes bit-exactly from a copied mid-run state in a world with other players (reconciliation)', async () => {
    const script = (i: number) => ({
      buttons:
        (i % 80 < 50 ? Forward | Sprint : Left) |
        (i % 97 === 0 ? Jump : 0) |
        (i % 211 > 180 ? Crouch : 0),
      yaw: (i * 131) & 0xffff,
      pitch: 0,
    });
    const server = await createSim([-10, 0, 10]);
    for (let i = 0; i < 300; i++) server.run(1, script(i));
    const snapshot: PlayerState = JSON.parse(JSON.stringify(server.state));

    const client = await createSim([0, 0, 0]);
    for (let k = 0; k < 11; k++) createPlayerBody(client.ctx); // other players' sensor capsules
    client.state = snapshot;
    for (let i = 300; i < 900; i++) {
      server.run(1, script(i));
      client.run(1, script(i));
    }
    expect(client.state).toEqual(server.state);
  });

  it('keeps position and velocity float32-exact (ADR 0003)', async () => {
    const sim = await createSim([3.3, 0, -7.1]);
    sim.run(120, { buttons: Forward | Left, yaw: 1234 });
    for (const v of [...sim.state.position, ...sim.state.velocity]) expect(Math.fround(v)).toBe(v);
  });
});
