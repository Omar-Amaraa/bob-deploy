import type { Clock } from '@bob-deploy/contracts';

/** A controllable clock for deterministic tests: no real timers, no real Date.now(). */
export class FakeClock implements Clock {
  private current: Date;
  private handles = new Map<unknown, { fn: () => void; at: number }>();
  private nextHandle = 1;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(startIso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.handles.set(handle, { fn, at: this.current.getTime() + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.handles.delete(handle);
  }

  /** Advances the clock and fires any timers whose time has come, in order. */
  advance(ms: number): void {
    const target = this.current.getTime() + ms;
    const due = [...this.handles.entries()]
      .filter(([, t]) => t.at <= target)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [handle, t] of due) {
      this.handles.delete(handle);
      this.current = new Date(t.at);
      t.fn();
    }
    this.current = new Date(target);
  }
}
