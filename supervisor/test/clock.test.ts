import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDailyRun, startDailyClock } from "../src/clock.js";

test("next daily report is local 09:00 today or tomorrow", () => {
  assert.equal(nextDailyRun(new Date(2026, 10, 6, 8, 30)).getHours(), 9);
  const after = nextDailyRun(new Date(2026, 10, 6, 9, 1));
  assert.equal(after.getDate(), 7);
  assert.equal(after.getHours(), 9);
});

test("accelerated first run fires once and then arms the daily clock", async () => {
  const callbacks: Array<() => void | Promise<void>> = [];
  const delays: number[] = [];
  const fakeSet = ((fn: () => void, delay?: number) => {
    callbacks.push(fn);
    delays.push(delay ?? 0);
    return { fake: true } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  let runs = 0;
  const clock = startDailyClock(async () => { runs += 1; }, {
    firstDelayMs: 25,
    now: () => new Date(2026, 10, 6, 8, 0),
    setTimer: fakeSet,
  });
  assert.equal(delays[0], 25);
  await callbacks[0]?.();
  assert.equal(runs, 1);
  assert.equal(callbacks.length, 2);
  clock.stop();
});
