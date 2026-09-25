export interface BotArgs {
  count: number;
  room?: string;
  url: string;
  /** Stop after this many seconds and print a summary (for automated netcode tests). */
  duration?: number;
  /** Write bot 1's inputs (as sent) to this JSON file when --duration ends. */
  record?: string;
  /** wander (default) | duel: one strafing target + one shooter (Phase 2 hit-registration test). */
  mode: 'wander' | 'duel';
}

/** Parses `--count 11 --room <id> --url http://localhost:2567`. */
export function parseArgs(argv: readonly string[]): BotArgs {
  const args: BotArgs = { count: 1, url: 'http://localhost:2567', mode: 'wander' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--') continue;
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case '--count': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer`);
        args.count = n;
        break;
      }
      case '--room':
        args.room = value;
        break;
      case '--url':
        args.url = value;
        break;
      case '--mode':
        if (value !== 'wander' && value !== 'duel')
          throw new Error('--mode must be wander or duel');
        args.mode = value;
        break;
      case '--record':
        args.record = value;
        break;
      case '--duration': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0)
          throw new Error(`--duration must be a positive number of seconds`);
        args.duration = n;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
    i++;
  }
  return args;
}
