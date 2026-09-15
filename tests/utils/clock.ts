import type { Clock } from "../../src/types.js";

/** Clock whose timeouts fire only when the test says so. No real waiting. */
export class FakeClock implements Clock {
  readonly requestedTimeoutsMs: number[] = [];
  private expired = false;
  private pending: Array<() => void> = [];

  timeout(ms: number): Promise<never> {
    this.requestedTimeoutsMs.push(ms);
    return new Promise<never>((_, reject) => {
      const fire = () => reject(new Error(`timeout after ${ms} ms`));
      if (this.expired) fire();
      else this.pending.push(fire);
    });
  }

  /** Fires every outstanding timeout, and any requested from now on. */
  expireTimeouts(): void {
    this.expired = true;
    const due = this.pending;
    this.pending = [];
    for (const fire of due) fire();
  }
}
