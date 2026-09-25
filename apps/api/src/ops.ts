import { Metrics, createLogger } from '@sentinel/auth';

export const log = createLogger('api');
export const metrics = new Metrics();
export const counters = {
  requests: metrics.counter('sentinel_api_requests_total', 'HTTP requests'),
  guests: metrics.counter('sentinel_api_guests_created_total', 'Guest tokens issued'),
  matches: metrics.counter('sentinel_api_matches_recorded_total', 'Match results recorded'),
  rejected: metrics.counter(
    'sentinel_api_match_results_rejected_total',
    'Match results refused (signature, replay, invalid)',
  ),
  rateLimited: metrics.counter(
    'sentinel_api_rate_limited_total',
    'Requests refused by rate limits',
  ),
};
