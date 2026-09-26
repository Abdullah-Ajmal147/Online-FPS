import { weaponCatalog, type Weapon } from '@sentinel/content';

const CLASS_LABEL: Record<Weapon['class'], string> = {
  rifle: 'Assault rifle',
  smg: 'SMG',
  shotgun: 'Shotgun',
  marksman: 'Marksman rifle',
  sidearm: 'Sidearm',
};

/** 0–1 bars for the picker, all derived from weapon data (nothing hand-entered per weapon). */
function stats(w: Weapon): [string, number][] {
  const perShot = w.damage.torso * w.pellets;
  return [
    ['Damage', Math.min(1, perShot / 110)],
    ['Fire rate', Math.min(1, w.rpm / 900)],
    ['Range', Math.min(1, w.falloff.end / 100)],
    ['Mobility', Math.min(1, Math.max(0, (w.moveSpeedMultiplier - 0.85) / 0.2))],
  ];
}

interface Props {
  primary: string;
  secondary: string;
  onChange: (primary: string, secondary: string) => void;
}

/** Primary / sidearm picker. The choice applies at the next spawn (the server enforces it). */
export function LoadoutPicker({ primary, secondary, onChange }: Props) {
  const slot = (s: 0 | 1) => weaponCatalog.filter((w) => w.slot === s);
  const card = (w: Weapon, selected: boolean, pick: () => void) => (
    <button
      key={w.id}
      class={`weapon-card${selected ? ' selected' : ''}`}
      data-testid={`weapon-${w.id}`}
      aria-pressed={selected}
      onClick={pick}
    >
      <span class="wc-name">{w.name}</span>
      <span class="wc-class">{CLASS_LABEL[w.class]}</span>
      {stats(w).map(([label, v]) => (
        <span class="weapon-stat" key={label}>
          <span>{label}</span>
          <span class="weapon-bar">
            <span style={{ width: `${Math.round(v * 100)}%` }} />
          </span>
        </span>
      ))}
    </button>
  );
  const secondaries = slot(1);
  return (
    <div class="loadout" data-testid="loadout">
      <div class="weapon-grid">
        {slot(0).map((w) => card(w, w.id === primary, () => onChange(w.id, secondary)))}
      </div>
      {secondaries.length > 1 && (
        <div class="weapon-grid">
          {secondaries.map((w) => card(w, w.id === secondary, () => onChange(primary, w.id)))}
        </div>
      )}
      <p class="menu-hint">
        Sidearm: {weaponCatalog.find((w) => w.id === secondary)?.name}. Changes apply the next time
        you spawn.
      </p>
    </div>
  );
}
