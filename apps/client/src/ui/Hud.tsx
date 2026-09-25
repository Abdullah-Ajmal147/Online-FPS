import { useEffect, useState } from 'preact/hooks';
import { getStatus, subscribe } from '../store.ts';

export function Hud() {
  const [status, setStatus] = useState(getStatus);
  useEffect(() => subscribe(setStatus), []);

  return (
    <div class="hud-corner">
      <div>
        <span class="status-dot" data-state={status.net.state} />
        <span data-testid="net-status">{status.net.text}</span>
      </div>
      <div data-testid="render-backend">renderer: {status.backend}</div>
    </div>
  );
}
