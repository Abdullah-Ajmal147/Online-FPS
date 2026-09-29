import { feel as defaultFeel, kickFor, weaponCatalog, type Kick } from '@sentinel/content';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Grade } from '../game/post.ts';
import { TTK_RANGES, ttk } from '../game/ttk.ts';
import { devStats, tuning } from '../game/tuning.ts';

/** The feel.json as shipped, for "Reset". */
const SHIPPED = JSON.stringify(defaultFeel);

type FeelNumber =
  | 'tracerEvery'
  | 'tracerSpeed'
  | 'tracerLength'
  | 'sprintFovBoost'
  | 'tacSprintFovBoost'
  | 'strafeTilt'
  | 'shotShake'
  | 'sway'
  | 'gunBob';

const FEEL_SLIDERS: [FeelNumber, string, number, number, number][] = [
  ['tracerEvery', 'tracer every N rounds', 1, 10, 1],
  ['tracerSpeed', 'tracer speed m/s', 50, 2000, 10],
  ['tracerLength', 'tracer length m', 0.2, 20, 0.1],
  ['sprintFovBoost', 'sprint FOV +°', 0, 15, 0.5],
  ['tacSprintFovBoost', 'tactical sprint FOV +°', 0, 20, 0.5],
  ['strafeTilt', 'strafe tilt °', 0, 6, 0.1],
  ['shotShake', 'shake per shot', 0, 1, 0.01],
  ['sway', 'weapon sway', 0, 3, 0.05],
  ['gunBob', 'gun bob', 0, 3, 0.05],
];

const KICK_SLIDERS: [keyof Kick, string, number, number, number][] = [
  ['back', 'back m', 0, 0.2, 0.001],
  ['up', 'up m', 0, 0.1, 0.001],
  ['pitch', 'pitch °', 0, 20, 0.1],
  ['yaw', 'yaw ±°', 0, 10, 0.1],
  ['roll', 'roll ±°', 0, 15, 0.1],
  ['frequency', 'spring speed', 5, 80, 0.5],
  ['dampingRatio', 'damping (1 = no wobble)', 0.2, 2, 0.05],
  ['adsScale', 'aiming × kick', 0, 1, 0.05],
];

const GRADE_SLIDERS: [
  keyof Grade & ('contrast' | 'saturation' | 'vignette' | 'grain'),
  string,
  number,
  number,
  number,
][] = [
  ['contrast', 'contrast', 0.6, 1.6, 0.01],
  ['saturation', 'saturation', 0, 2, 0.01],
  ['vignette', 'vignette', 0, 1, 0.01],
  ['grain', 'grain', 0, 0.15, 0.002],
];

/**
 * F1 tuning panel: live frame-time graph and renderer counters, sliders for how shooting and
 * moving feel on screen (feel.json) and the colour grade, and a time-to-kill table from the
 * weapon data. "Copy feel.json" puts the tuned values on the clipboard to paste into
 * packages/content/src/feel.json. Hits, damage, movement and recoil are the server's and are
 * tuned in their content files, not here.
 */
export function TuningPanel() {
  const [open, setOpen] = useState(false);
  const [, redraw] = useState(0);
  const bump = () => {
    tuning.version++;
    redraw((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'F1') return;
      e.preventDefault(); // F1 is also the browser's help page
      setOpen((o) => {
        // Opening it frees the mouse for the sliders (the game pauses; click Resume to play).
        if (!o) document.exitPointerLock?.();
        return !o;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const f = tuning.feel;
  const w = tuning.weapon;
  const perWeapon = f.weaponKick[w.id] !== undefined;
  const kick = kickFor(f, w);
  const grade = tuning.grade ?? tuning.mapGrade;
  const exposure = tuning.exposure ?? tuning.mapExposure;

  return (
    <div class="tuning-panel" data-testid="tuning-panel">
      <div class="tuning-head">
        <b>Tuning</b> <span>F1 to close</span>
      </div>
      <Stats />

      <Section title="Feel">
        {FEEL_SLIDERS.map(([k, label, min, max, step]) => (
          <Slider
            key={k}
            label={label}
            min={min}
            max={max}
            step={step}
            value={f[k]}
            testid={`tune-${k}`}
            onInput={(v) => {
              f[k] = v;
              bump();
            }}
          />
        ))}
      </Section>

      <Section title={`Gun kick · ${perWeapon ? w.id : `${w.class} class`}`}>
        {KICK_SLIDERS.map(([k, label, min, max, step]) => (
          <Slider
            key={k}
            label={label}
            min={min}
            max={max}
            step={step}
            value={kick[k]}
            onInput={(v) => {
              kick[k] = v;
              bump();
            }}
          />
        ))}
      </Section>

      <Section title="Look (Medium / High)">
        <Slider
          label="exposure"
          min={0.2}
          max={1.4}
          step={0.01}
          value={exposure}
          onInput={(v) => {
            tuning.exposure = v;
            bump();
          }}
        />
        {grade &&
          GRADE_SLIDERS.map(([k, label, min, max, step]) => (
            <Slider
              key={k}
              label={label}
              min={min}
              max={max}
              step={step}
              value={grade[k]}
              onInput={(v) => {
                tuning.grade = { ...grade, [k]: v };
                bump();
              }}
            />
          ))}
      </Section>

      <Section title="Time to kill (body / head)">
        <table class="tuning-ttk" data-testid="ttk-table">
          <thead>
            <tr>
              <th />
              {TTK_RANGES.map((r) => (
                <th key={r}>{r} m</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weaponCatalog.map((wp) => (
              <tr key={wp.id}>
                <th>{wp.name}</th>
                {TTK_RANGES.map((r) => {
                  const t = ttk(wp, r);
                  return (
                    <td key={r} title={`${t.bodyShots} / ${t.headShots} shots`}>
                      {t.bodyMs} / {t.headMs}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div class="tuning-actions">
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(f, null, 2) + '\n')}
        >
          Copy feel.json
        </button>
        <button
          type="button"
          onClick={() => {
            Object.assign(f, JSON.parse(SHIPPED));
            tuning.grade = null;
            tuning.exposure = null;
            bump();
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function Section(props: { title: string; children: preact.ComponentChildren }) {
  return (
    <details class="tuning-section" open>
      <summary>{props.title}</summary>
      {props.children}
    </details>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  testid?: string;
  onInput: (v: number) => void;
}) {
  return (
    <label class="tuning-row">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        data-testid={props.testid}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
      />
      <output>{Number(props.value.toFixed(3))}</output>
    </label>
  );
}

/** Frame-time graph (last 4 s) and the renderer's counters, redrawn every animation frame. */
function Stats() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const sorted = new Float32Array(devStats.frames.length);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      const n = devStats.frames.length;
      g.clearRect(0, 0, c.width, c.height);
      // Guides at 60 fps (16.7 ms) and 30 fps (33.3 ms); the graph tops out at 50 ms.
      const y = (ms: number) => c.height - (Math.min(ms, 50) / 50) * c.height;
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, y(16.7), c.width, 1);
      g.fillRect(0, y(33.3), c.width, 1);
      for (let i = 0; i < n; i++) {
        const ms = devStats.frames[(devStats.head + i) % n]!;
        g.fillStyle = ms > 33.3 ? '#ff5a4f' : ms > 17.5 ? '#ffc44d' : '#5ad18a';
        g.fillRect(i, y(ms), 1, c.height - y(ms));
      }
      sorted.set(devStats.frames);
      sorted.sort();
      const avg = sorted.reduce((a, b) => a + b, 0) / n;
      const p95 = sorted[Math.floor(n * 0.95)]!;
      const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
      if (text.current)
        text.current.textContent =
          `${avg > 0 ? (1000 / avg).toFixed(0) : '—'} fps · avg ${avg.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms\n` +
          `draw calls ${devStats.drawCalls} · triangles ${devStats.triangles.toLocaleString()}\n` +
          `geometries ${devStats.geometries} · textures ${devStats.textures}` +
          (mem ? ` · JS heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '') +
          `\n${devStats.backend} · render scale ${devStats.renderScale.toFixed(2)}`;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div class="tuning-stats">
      <canvas ref={canvas} width={240} height={56} data-testid="frame-graph" />
      <div ref={text} class="tuning-counters" data-testid="tuning-counters" />
    </div>
  );
}
