/**
 * Minimal operations helpers shared by the game server and the API (Node only): structured
 * logs and Prometheus-style metrics, with no extra dependencies.
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LEVELS: Level[] = ['debug', 'info', 'warn', 'error', 'fatal'];

/**
 * JSON lines in production (for log collectors), readable text in development.
 *   log.info('match ended', { room: 'abc', winner: 1 })
 */
export function createLogger(
  service: string,
  env: Record<string, string | undefined> = process.env,
) {
  const json = env.NODE_ENV === 'production' || env.LOG_FORMAT === 'json';
  const min = LEVELS.indexOf((env.LOG_LEVEL as Level) ?? 'info');
  const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS.indexOf(level) < min) return;
    const out = level === 'error' || level === 'fatal' ? console.error : console.log;
    if (json) {
      out(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          service,
          msg,
          ...serialize(fields),
        }),
      );
    } else {
      const extra = Object.keys(fields).length ? ` ${JSON.stringify(serialize(fields))}` : '';
      out(`[${service}] ${level === 'info' ? '' : `${level.toUpperCase()} `}${msg}${extra}`);
    }
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
    info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
    warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
    error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
    fatal: (m: string, f?: Record<string, unknown>) => write('fatal', m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;

function serialize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

/** Counters and gauges rendered in the Prometheus text format for GET /metrics. */
export class Metrics {
  private counters = new Map<string, { help: string; value: number }>();
  private gauges = new Map<string, { help: string; read: () => number }>();

  counter(name: string, help: string): { inc: (by?: number) => void } {
    const c = { help, value: 0 };
    this.counters.set(name, c);
    return { inc: (by = 1) => void (c.value += by) };
  }

  /** A value read at scrape time. */
  gauge(name: string, help: string, read: () => number): void {
    this.gauges.set(name, { help, read });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`, `${name} ${c.value}`);
    }
    for (const [name, g] of this.gauges) {
      const v = g.read();
      lines.push(
        `# HELP ${name} ${g.help}`,
        `# TYPE ${name} gauge`,
        `${name} ${Number.isFinite(v) ? v : 0}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}

/** Rolling window of recent samples (e.g. tick times) with percentiles for gauges. */
export class Window {
  private samples: number[] = [];
  constructor(private readonly size: number) {}
  add(v: number): void {
    this.samples.push(v);
    if (this.samples.length > this.size) this.samples.shift();
  }
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  }
}
