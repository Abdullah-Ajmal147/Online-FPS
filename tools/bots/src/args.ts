export interface BotArgs {
  count: number;
  room?: string;
  url: string;
  /** Stop after this many seconds and print a summary (for automated netcode tests). */
  duration?: number;
}

/** Parses `--count 11 --room <id> --url http://localhost:2567`. */
export function parseArgs(argv: readonly string[]): BotArgs {
  const args: BotArgs = { count: 1, url: 'http://localhost:2567' };
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
