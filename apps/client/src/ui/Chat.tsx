import { useEffect, useRef, useState } from 'preact/hooks';
import { CHAT_MAX_CHARS } from '@sentinel/protocol';
import { isMuted, toggleMute } from '../social.ts';
import { chatBridge, getStatus } from '../store.ts';
import { useStatus } from './Hud.tsx';

const SHOW_MS = 12_000;

/**
 * Text chat: Enter to talk to everyone, T to your team. Lines fade after a few seconds while
 * playing; with the menu open the whole recent log shows and a click on a name mutes them.
 */
export function Chat() {
  const { chat, playing } = useStatus();
  const [open, setOpen] = useState<'all' | 'team' | null>(null);
  const [text, setText] = useState('');
  const [, setNow] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || !getStatus().inMatch || e.target instanceof HTMLInputElement || e.repeat) return;
      const mode = e.code === 'Enter' ? 'all' : e.code === 'KeyT' ? 'team' : null;
      if (!mode) return;
      e.preventDefault();
      chatBridge.opened();
      setOpen(mode);
    };
    window.addEventListener('keydown', onKey);
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const now = performance.now();
  const lines = chat
    .filter((l) => !isMuted(l.muteKey))
    .filter((l) => open || !playing || now - l.at < SHOW_MS)
    .slice(open || !playing ? -10 : -6);

  return (
    <div class="chat" data-testid="chat">
      {lines.map((l) => (
        <div class="chat-line" key={l.key}>
          {l.teamOnly && <span class="chat-team">[team] </span>}
          <button
            class={`chat-name team-${l.team}`}
            title={playing ? '' : 'Click to mute'}
            disabled={playing}
            onClick={() => {
              toggleMute(l.muteKey);
              setNow(performance.now());
            }}
          >
            {l.name}
          </button>
          : {l.text}
        </div>
      ))}
      {open && (
        <input
          ref={input}
          class="chat-input"
          data-testid="chat-input"
          maxLength={CHAT_MAX_CHARS}
          placeholder={open === 'team' ? 'Team chat…' : 'Say something…'}
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (text.trim()) chatBridge.send(open === 'team', text.trim());
              setText('');
              setOpen(null);
            } else if (e.key === 'Escape') {
              setText('');
              setOpen(null);
            }
          }}
          onBlur={() => setOpen(null)}
        />
      )}
    </div>
  );
}
