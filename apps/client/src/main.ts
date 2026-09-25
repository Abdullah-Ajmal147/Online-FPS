import { h, render } from 'preact';
import { connect } from './net.ts';
import { startRenderer } from './renderer.ts';
import { setStatus } from './store.ts';
import { Hud } from './ui/Hud.tsx';

render(h(Hud, null), document.getElementById('ui')!);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
startRenderer(canvas)
  .then((backend) => setStatus({ backend }))
  .catch((err: unknown) => console.error('[renderer] failed to start:', err));

void connect();
