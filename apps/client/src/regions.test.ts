import { describe, expect, it } from 'vitest';
import { parseRegions, pickRegion } from './regions.ts';

const FALLBACK = 'http://localhost:2567';
const LIST = JSON.stringify([
  { id: 'eu-west', name: 'EU West', url: 'https://eu.example.com' },
  { id: 'na-east', name: 'NA East', url: 'https://na.example.com' },
]);

describe('regions', () => {
  it('parses the build-time list; anything malformed means the single default region', () => {
    expect(parseRegions(LIST, FALLBACK).map((r) => r.id)).toEqual(['eu-west', 'na-east']);
    for (const bad of [
      undefined,
      'not json',
      '[]',
      '[{"id":"EU!","name":"x","url":"https://a.b"}]',
      '[{"id":"eu","name":"x","url":"javascript:alert(1)"}]',
      '[{"id":"eu","name":"x","url":"https://a"},{"id":"eu","name":"y","url":"https://b"}]',
    ]) {
      expect(parseRegions(bad, FALLBACK)).toEqual([
        { id: 'default', name: 'Default', url: FALLBACK },
      ]);
    }
  });

  it('invite region, then the player’s pick, then lowest ping, then the first', () => {
    const regions = parseRegions(LIST, FALLBACK);
    const pings = { 'eu-west': 90, 'na-east': 35 };
    expect(pickRegion(regions, pings, 'auto').id).toBe('na-east');
    expect(pickRegion(regions, pings, 'eu-west').id).toBe('eu-west');
    expect(pickRegion(regions, pings, 'na-east', 'eu-west').id).toBe('eu-west');
    expect(pickRegion(regions, pings, 'auto', 'mars').id).toBe('na-east'); // unknown invite
    expect(pickRegion(regions, { 'eu-west': null, 'na-east': null }, 'auto').id).toBe('eu-west');
    expect(pickRegion(regions, { 'eu-west': 200, 'na-east': null }, 'auto').id).toBe('eu-west');
  });
});
