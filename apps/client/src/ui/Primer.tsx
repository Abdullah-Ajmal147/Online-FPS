import { useEffect, useMemo, useState } from 'preact/hooks';
import { completes, primerSteps, setPrimerDone, type PrimerEvent } from '../primer.ts';
import type { Settings } from '../settings.ts';

/**
 * First-match tips, one line at a time above the ammo counter. Each step finishes when the
 * player does it; Backspace skips the rest. Only shown until finished once (Settings can
 * bring it back).
 */
export function Primer({ settings }: { settings: Settings }) {
  const steps = useMemo(() => primerSteps(settings), [settings]);
  const [index, setIndex] = useState(0);
  const [shownAt, setShownAt] = useState(() => performance.now());
  const step = steps[index];

  useEffect(() => {
    if (!step) {
      setPrimerDone(true); // the next status update unmounts us
      return;
    }
    const next = () => {
      setIndex((i) => i + 1);
      setShownAt(performance.now());
    };
    const check = (e: PrimerEvent) => completes(step, e) && next();
    const typing = () => document.activeElement instanceof HTMLInputElement;
    const key = (e: KeyboardEvent) => {
      if (typing()) return;
      if (e.code === 'Backspace') {
        setIndex(steps.length);
        return;
      }
      check({ key: e.code });
    };
    const mouse = (e: MouseEvent) => check({ mouse: e.button });
    const timer = setInterval(() => check({ elapsed: (performance.now() - shownAt) / 1000 }), 250);
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', mouse);
    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', key);
      window.removeEventListener('mousedown', mouse);
    };
  }, [step, steps.length, shownAt]);

  if (!step) return null;
  return (
    <div class="primer" data-testid="primer" data-step={step.id} role="status">
      <div class="primer-count">
        Field primer {index + 1}/{steps.length}
      </div>
      <div class="primer-text">{step.text}</div>
      <div class="primer-skip">Backspace to skip</div>
    </div>
  );
}
