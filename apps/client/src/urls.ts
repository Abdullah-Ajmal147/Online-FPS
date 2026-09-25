/**
 * Override a server/API URL from the page's query string (`?server=`, `?api=`) — but only in
 * development, or for hosts listed at build time in VITE_ALLOWED_HOSTS (comma-separated, e.g.
 * regional servers). Otherwise a crafted link could send a player's guest token to any host.
 */
export function urlFromQuery(param: string): string | null {
  const value = new URLSearchParams(location.search).get(param);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (import.meta.env.DEV) return value;
  const allowed = String(import.meta.env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(url.hostname.toLowerCase()) ? value : null;
}
