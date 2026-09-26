import {
  MAX_ATTACHMENTS,
  MAX_PERKS,
  attachmentCatalog,
  attachmentUnlockLevel,
  buildLoadout,
  hasAttachment,
  hasPerk,
  hasWeapon,
  unlockLevel,
  weaponLevelFor,
  type Access,
  perkCatalog,
  weaponCatalog,
  type Attachment,
  type LoadoutChoice,
  type Weapon,
} from '@sentinel/content';

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
  choice: LoadoutChoice;
  onChange: (next: LoadoutChoice) => void;
  /** The player's unlocks (from their profile); locked items are shown but can't be picked. */
  access: Access;
}

const SLOT_LABEL: Record<Attachment['slot'], string> = {
  optic: 'Optic',
  barrel: 'Barrel',
  magazine: 'Magazine',
  grip: 'Grip',
  stock: 'Stock',
};

/** Primary / sidearm picker. The choice applies at the next spawn (the server enforces it). */
export function LoadoutPicker({ choice, onChange, access }: Props) {
  // Always show the stats of the weapon as built (attachments and perks applied).
  const built = buildLoadout(choice, access);
  const pick = (next: Partial<LoadoutChoice>) =>
    onChange(buildLoadout({ ...choice, ...next }, access).choice);
  const slot = (s: 0 | 1) => weaponCatalog.filter((w) => w.slot === s);
  const card = (w: Weapon, selected: boolean, pick: () => void) => {
    const locked = !hasWeapon(access, w.id);
    return (
      <button
        key={w.id}
        class={`weapon-card${selected ? ' selected' : ''}`}
        data-testid={`weapon-${w.id}`}
        aria-pressed={selected}
        disabled={locked}
        onClick={pick}
      >
        <span class="wc-name">{w.name}</span>
        {locked && <span class="lock">Unlocks at level {unlockLevel('weapons', w.id)}</span>}
        <span class="wc-class">{CLASS_LABEL[w.class]}</span>
        {stats(selected && w.slot === 0 ? built.weapons[0] : w).map(([label, v]) => (
          <span class="weapon-stat" key={label}>
            <span>{label}</span>
            <span class="weapon-bar">
              <span style={{ width: `${Math.round(v * 100)}%` }} />
            </span>
          </span>
        ))}
      </button>
    );
  };
  const secondaries = slot(1);
  return (
    <div class="loadout" data-testid="loadout">
      <div class="weapon-grid">
        {slot(0).map((w) => card(w, w.id === built.choice.primary, () => pick({ primary: w.id })))}
      </div>
      {secondaries.length > 1 && (
        <div class="weapon-grid">
          {secondaries.map((w) =>
            card(w, w.id === built.choice.secondary, () => pick({ secondary: w.id })),
          )}
        </div>
      )}
      <h3 class="loadout-h">
        Attachments ({built.choice.attachments.length}/{MAX_ATTACHMENTS}) · {built.weapons[0].name}{' '}
        weapon level {weaponLevelFor(access.weaponKills[built.choice.primary] ?? 0)}
      </h3>
      <Attachments
        access={access}
        weapon={built.weapons[0]}
        chosen={built.choice.attachments}
        onToggle={(id) => {
          const on = built.choice.attachments.includes(id);
          const slotOf = (x: string) => attachmentCatalog.find((a) => a.id === x)?.slot;
          // Picking a second attachment for a slot replaces the first.
          const rest = built.choice.attachments.filter((x) => slotOf(x) !== slotOf(id));
          pick({ attachments: on ? rest : [...rest, id] });
        }}
      />
      <h3 class="loadout-h">
        Perks ({built.choice.perks.length}/{MAX_PERKS})
      </h3>
      <div class="chip-list">
        {perkCatalog.map((p) => {
          const on = built.choice.perks.includes(p.id);
          const locked = !hasPerk(access, p.id);
          return (
            <button
              key={p.id}
              class={`chip${on ? ' on' : ''}`}
              data-testid={`perk-${p.id}`}
              aria-pressed={on}
              title={p.description}
              disabled={locked || (!on && built.choice.perks.length >= MAX_PERKS)}
              onClick={() =>
                pick({
                  perks: on
                    ? built.choice.perks.filter((x) => x !== p.id)
                    : [...built.choice.perks, p.id],
                })
              }
            >
              <b>{p.name}</b>
              <span>
                {locked ? `Unlocks at level ${unlockLevel('perks', p.id)}` : p.description}
              </span>
            </button>
          );
        })}
      </div>
      <p class="menu-hint">
        Sidearm: {built.weapons[1].name}. Changes apply the next time you spawn.
      </p>
    </div>
  );
}

/** Attachments that fit the primary, grouped by slot; one per slot. */
function Attachments(props: {
  access: Access;
  weapon: Weapon;
  chosen: readonly string[];
  onToggle: (id: string) => void;
}) {
  const fits = attachmentCatalog.filter((a) => a.classes.includes(props.weapon.class));
  const order = Object.keys(SLOT_LABEL);
  const slots = [...new Set(fits.map((a) => a.slot))].sort(
    (x, y) => order.indexOf(x) - order.indexOf(y),
  );
  const slotOf = (id: string) => attachmentCatalog.find((c) => c.id === id)?.slot;
  return (
    <div class="attachment-slots">
      {slots.map((slot) => {
        const slotTaken = props.chosen.some((x) => slotOf(x) === slot);
        return (
          <div class="attachment-slot" key={slot}>
            <span class="slot-label">{SLOT_LABEL[slot]}</span>
            <div class="chip-list">
              {fits
                .filter((a) => a.slot === slot)
                .map((a) => {
                  const on = props.chosen.includes(a.id);
                  const full = props.chosen.length >= MAX_ATTACHMENTS && !slotTaken;
                  const locked = !hasAttachment(props.access, props.weapon.id, a.id);
                  return (
                    <button
                      key={a.id}
                      class={`chip${on ? ' on' : ''}`}
                      data-testid={`attachment-${a.id}`}
                      aria-pressed={on}
                      title={a.description}
                      disabled={full || locked}
                      onClick={() => props.onToggle(a.id)}
                    >
                      <b>{a.name}</b>
                      <span>
                        {locked ? `Weapon level ${attachmentUnlockLevel(a.id)}` : a.description}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
