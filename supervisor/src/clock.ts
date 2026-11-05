// Local-time daily 09:00 scheduler. Recomputing after every run handles DST.
export function nextDailyRun(now: Date, hour = 9): Date {
  const next = new Date(now.getTime());
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function startDailyClock(
  run: () => Promise<void>,
  opts: { hour?: number; firstDelayMs?: number; now?: () => Date; setTimer?: typeof setTimeout } = {},
): { stop: () => void; nextRun: Date } {
  const hour = Number.isInteger(opts.hour) && (opts.hour as number) >= 0 && (opts.hour as number) <= 23 ? opts.hour as number : 9;
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimer ?? setTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const firstNext = opts.firstDelayMs !== undefined
    ? new Date(now().getTime() + Math.max(1, opts.firstDelayMs))
    : nextDailyRun(now(), hour);
  const arm = (at: Date): void => {
    const delay = Math.max(1, at.getTime() - now().getTime());
    timer = setTimer(async () => {
      if (stopped) return;
      try { await run(); } finally { if (!stopped) arm(nextDailyRun(now(), hour)); }
    }, delay);
  };
  arm(firstNext);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); }, nextRun: firstNext };
}
