import { Metrics, Window, createLogger } from '@sentinel/auth';

/** Server-wide logger and metrics (GET /metrics on the game server). */
export const log = createLogger('server');
export const metrics = new Metrics();

/** Tick durations (ms) over the last 60 s across all rooms. */
export const tickWindow = new Window(60 * 60);
export const counters = {
  ticks: metrics.counter('sentinel_ticks_total', 'Simulation ticks run'),
  slowTicks: metrics.counter('sentinel_slow_ticks_total', 'Ticks slower than the 4 ms budget'),
  tickErrors: metrics.counter('sentinel_tick_errors_total', 'Ticks that threw and were skipped'),
  matches: metrics.counter('sentinel_matches_total', 'Matches finished'),
  joins: metrics.counter('sentinel_joins_total', 'Players who joined a match'),
  rejectedJoins: metrics.counter(
    'sentinel_rejected_joins_total',
    'Joins refused (version or rate limit)',
  ),
};

/** Live rooms register here so gauges can count players at scrape time. */
export const liveRooms = new Set<{ humans(): number; bots(): number }>();

metrics.gauge('sentinel_rooms', 'Active match rooms', () => liveRooms.size);
metrics.gauge('sentinel_players_human', 'Connected human players', () =>
  [...liveRooms].reduce((n, r) => n + r.humans(), 0),
);
metrics.gauge('sentinel_players_bot', 'Server bots in matches', () =>
  [...liveRooms].reduce((n, r) => n + r.bots(), 0),
);
metrics.gauge('sentinel_tick_ms_p50', 'Median tick time, last 60 s', () =>
  tickWindow.percentile(0.5),
);
metrics.gauge('sentinel_tick_ms_p99', '99th percentile tick time, last 60 s', () =>
  tickWindow.percentile(0.99),
);
metrics.gauge(
  'sentinel_process_rss_mb',
  'Resident memory (MB)',
  () => process.memoryUsage().rss / 1048576,
);
