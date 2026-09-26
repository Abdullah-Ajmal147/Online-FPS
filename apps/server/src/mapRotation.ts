import { MAP_ROTATION, maps } from '@sentinel/content';

/**
 * Which maps a room plays: SENTINEL_MAP pins one (tests use the open "arena"),
 * SENTINEL_MAP_ROTATION (comma-separated) sets the rotation, otherwise the default rotation.
 * Throws at startup on an unknown map id rather than failing at the first rotation.
 */
export function mapRotationFromEnv(env: Record<string, string | undefined>): string[] {
  const list = env.SENTINEL_MAP
    ? [env.SENTINEL_MAP]
    : (env.SENTINEL_MAP_ROTATION?.split(',')
        .map((id) => id.trim())
        .filter(Boolean) ?? []);
  const rotation = list.length > 0 ? list : [...MAP_ROTATION];
  const unknown = rotation.find((id) => !Object.hasOwn(maps, id));
  if (unknown) {
    throw new Error(
      `unknown map "${unknown}" in SENTINEL_MAP/SENTINEL_MAP_ROTATION (have ${Object.keys(maps).join(', ')})`,
    );
  }
  return rotation;
}
