import { describe, expect, it } from 'vitest';
import { completes, primerSteps } from './primer.ts';
import { DEFAULT_SETTINGS, rebind } from './settings.ts';

describe('first-match primer', () => {
  it('uses the player’s own key bindings', () => {
    const bindings = rebind(DEFAULT_SETTINGS.bindings, 'reload', 'KeyF');
    const steps = primerSteps({ bindings, mode: 'team-deathmatch' });
    const reload = steps.find((s) => s.id === 'reload')!;
    expect(reload.text).toContain('F');
    expect(completes(reload, { key: 'KeyF' })).toBe(true);
    expect(completes(reload, { key: 'KeyR' })).toBe(false);
  });

  it('mouse steps, and read-only steps that finish by time', () => {
    const steps = primerSteps(DEFAULT_SETTINGS);
    const ads = steps.find((s) => s.id === 'ads')!;
    expect(completes(ads, { mouse: 2 })).toBe(true);
    expect(completes(ads, { mouse: 0 })).toBe(false);
    expect(completes(ads, { elapsed: 60 })).toBe(false);
    const objective = steps.at(-1)!;
    expect(completes(objective, { elapsed: 2 })).toBe(false);
    expect(completes(objective, { elapsed: 7 })).toBe(true);
  });

  it('explains the objective of the chosen mode', () => {
    expect(primerSteps({ ...DEFAULT_SETTINGS, mode: 'domination' }).at(-1)!.text).toContain(
      'nodes A, B and C',
    );
    expect(primerSteps({ ...DEFAULT_SETTINGS, mode: 'team-deathmatch' }).at(-1)!.text).toContain(
      'kills wins',
    );
  });
});
