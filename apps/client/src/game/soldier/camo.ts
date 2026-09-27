import * as THREE from 'three/webgpu';

/**
 * Faction camouflage, painted procedurally (original, nothing to license): a base colour with
 * three layers of soft-edged blotches. Seeded, so every client paints the same pattern.
 */
export interface CamoPalette {
  base: string;
  layers: [string, string, string];
}

export const FACTION_CAMO: Record<number, CamoPalette> = {
  // Aegis Directive: cool urban greys with a hint of blue.
  0: { base: '#5b6470', layers: ['#434b56', '#7a8491', '#2f353e'] },
  // Ember Syndicate: dry-country tans and browns.
  1: { base: '#8f7a5c', layers: ['#6e5a40', '#a8936f', '#4a3b2a'] },
};

const cache = new Map<number, THREE.CanvasTexture>();

/** The team's camo texture (one per team, shared by every soldier of it). */
export function camoTexture(team: number): THREE.CanvasTexture {
  let tex = cache.get(team);
  if (tex) return tex;
  const palette = FACTION_CAMO[team] ?? FACTION_CAMO[0]!;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = palette.base;
  g.fillRect(0, 0, size, size);
  let seed = 1234567 + team * 7919;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  palette.layers.forEach((color, layer) => {
    g.fillStyle = color;
    const count = [26, 20, 14][layer]!;
    for (let i = 0; i < count; i++) {
      // A blotch = a few overlapping ellipses, drawn wrapped so the texture tiles.
      const cx = rand() * size;
      const cy = rand() * size;
      const parts = 3 + Math.floor(rand() * 3);
      for (let p = 0; p < parts; p++) {
        const x = cx + (rand() - 0.5) * 30;
        const y = cy + (rand() - 0.5) * 30;
        const rx = 8 + rand() * (22 - layer * 5);
        const ry = 5 + rand() * (14 - layer * 3);
        const rot = rand() * Math.PI;
        for (const dx of [-size, 0, size])
          for (const dy of [-size, 0, size]) {
            g.beginPath();
            g.ellipse(x + dx, y + dy, rx, ry, rot, 0, Math.PI * 2);
            g.fill();
          }
      }
    }
  });
  // Fine fabric grain.
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  g.putImageData(img, 0, 0);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  cache.set(team, tex);
  return tex;
}
