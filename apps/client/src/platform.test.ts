import { describe, expect, it } from 'vitest';
import { trackGameplay, type Platform } from './platform.ts';
import type { ClientStatus } from './store.ts';

function fake() {
  const calls: string[] = [];
  const p: Platform = {
    name: 'crazygames',
    externalLinks: false,
    loadingDone: () => calls.push('loaded'),
    gameplayStart: () => calls.push('start'),
    gameplayStop: () => calls.push('stop'),
    happyTime: () => calls.push('happy'),
  };
  let listener: (s: ClientStatus) => void = () => {};
  trackGameplay(p, (l) => (listener = l));
  const base = { inMatch: false, spawned: false, playing: false, match: null };
  const emit = (patch: object) => listener({ ...base, ...patch } as unknown as ClientStatus);
  return { calls, emit };
}

describe('platform gameplay tracking', () => {
  it('start/stop only on changes: menu, deploy, pause, resume, leave', () => {
    const { calls, emit } = fake();
    emit({}); // main menu
    emit({ inMatch: true, playing: true }); // deploying, not spawned yet
    emit({ inMatch: true, playing: true, spawned: true });
    emit({ inMatch: true, playing: true, spawned: true }); // many updates a second
    emit({ inMatch: true, playing: false, spawned: true }); // pause menu
    emit({ inMatch: true, playing: true, spawned: true }); // resume
    emit({}); // leave
    expect(calls).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('one happy time per won match', () => {
    const { calls, emit } = fake();
    const ended = (result: string) => ({
      inMatch: true,
      spawned: true,
      match: { phase: 'ended', result },
    });
    emit(ended('win'));
    emit(ended('win'));
    emit({ inMatch: true, spawned: true, match: { phase: 'warmup', result: null } });
    emit(ended('loss'));
    emit({ inMatch: true, spawned: true, match: { phase: 'live', result: null } });
    emit(ended('win'));
    expect(calls.filter((c) => c === 'happy')).toHaveLength(2);
  });
});
