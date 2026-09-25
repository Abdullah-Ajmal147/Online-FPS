import { useEffect, useState } from 'preact/hooks';
import { getStatus, subscribe, type ClientStatus } from '../store.ts';

export function useStatus(): ClientStatus {
  const [status, setStatus] = useState(getStatus);
  useEffect(() => subscribe(setStatus), []);
  return status;
}

export function Hud() {
  const status = useStatus();
  const p = status.player;

  return (
    <div class="hud-corner">
      <div>
        <span class="status-dot" data-state={status.net.state} />
        <span data-testid="net-status">{status.net.text}</span>
      </div>
      <div data-testid="render-backend">renderer: {status.backend}</div>
      {p && (
        <div data-testid="player-debug">
          pos {p.position.map((v) => v.toFixed(2)).join(' ')} · {p.speed.toFixed(1)} m/s
          {p.sliding ? ' · slide' : p.crouching ? ' · crouch' : ''}
          {p.grounded ? '' : ' · air'}
        </div>
      )}
    </div>
  );
}
