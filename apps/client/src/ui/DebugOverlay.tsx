import { useEffect, useState } from 'preact/hooks';
import { useStatus } from './Hud.tsx';

const fmt = (v: number | null | undefined, digits = 0, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;

/** F3 network/performance overlay (Phase 1 task 9). */
export function DebugOverlay() {
  const [open, setOpen] = useState(false);
  const status = useStatus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'F3') return;
      e.preventDefault(); // F3 is also the browser's "find"
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const n = status.netStats;
  const rows: [string, string][] = [
    ['fps', fmt(status.fps)],
    ['ping (rtt)', fmt(n?.rttMs, 0, ' ms')],
    ['snapshot loss', fmt(n?.snapshotLossPct, 1, ' %')],
    ['server tick', fmt(n?.serverTickMs, 2, ' ms')],
    ['corrections', fmt(n?.correctionPct, 2, ' %')],
    ['last error', fmt(n?.lastErrorCm, 1, ' cm')],
    ['input queue', fmt(n?.inputQueueDepth, 1)],
    ['interp delay', fmt(n?.interpDelayMs, 0, ' ms')],
    ['players seen', fmt(n?.remotePlayers)],
  ];
  return (
    <div class="debug-overlay" data-testid="debug-overlay">
      <div class="debug-title">{n ? 'network' : 'offline practice'} · F3 to close</div>
      {status.player && (
        <div class="debug-row" data-testid="player-debug">
          pos {status.player.position.map((v) => v.toFixed(2)).join(' ')} ·{' '}
          {status.player.speed.toFixed(1)} m/s
        </div>
      )}
      {rows.map(([k, v]) => (
        <div class="debug-row" key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
