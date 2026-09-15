// One set of expectations, run against whichever handler you point it at.
// Nothing here is tailored to a particular implementation.
//
// The first block is table stakes: both the original and the revised handler
// should pass all of it. The second block is the five things the team actually
// saw go wrong in production. The original handler fails every one of them.

import { describe, expect, it } from "vitest";
import type { Clock, Converter, Job, JobStore, QueueMessage } from "../src/types.improved.js";
import { FakeClock } from "./utils/clock.js";
import { ConverterExitError, FakeConverter } from "./utils/converter.js";
import { FakeMessage } from "./utils/message.js";
import { InMemoryJobStore } from "./utils/store.js";

export type Handle = (
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
) => Promise<void>;

const JOB_ID = "job-1";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    inputKey: "imports/job-1.mdb",
    status: "queued",
    attempt: 0,
    ...overrides,
  };
}

// A big city database that takes half an hour to package up.
function exportJob(overrides: Partial<Job> = {}): Job {
  return job({ inputKey: "exports/job-1.json", jobType: "export", ...overrides });
}

const flakyCrash = () => new ConverterExitError(137, "killed");
const brokenFile = () => new ConverterExitError(2, "required table missing");

// A clock that writes down how long it was asked to wait and then never fires,
// so a test can look at the number the handler picked.
class NoteTakingClock implements Clock {
  readonly asked: number[] = [];
  timeout(ms: number): Promise<never> {
    this.asked.push(ms);
    return new Promise<never>(() => {});
  }
}

export function createHandlerScenarios(name: string, handle: Handle): void {
  describe(`${name} — the basics`, () => {
    it("shrugs off a message for a job that isn't in the database", async () => {
      const store = new InMemoryJobStore();
      const converter = FakeConverter.succeeding();
      const message = new FakeMessage("long-gone-job");

      await handle(message, store, converter, new FakeClock());

      expect(message.ackCount).toBe(1);
      expect(message.retryCount).toBe(0);
      expect(converter.startCount).toBe(0);
    });

    it("doesn't redo a job that already finished", async () => {
      const store = new InMemoryJobStore();
      store.seed(job({ status: "succeeded", attempt: 1, outputKey: "jobs/job-1/result.json" }));
      const converter = FakeConverter.succeeding();
      const message = new FakeMessage(JOB_ID, 2);

      await handle(message, store, converter, new FakeClock());

      expect(converter.startCount).toBe(0);
      expect(store.writes).toHaveLength(0);
      expect(message.ackCount).toBe(1);
    });

    it("doesn't redo a job that already gave up", async () => {
      const store = new InMemoryJobStore();
      store.seed(job({ status: "failed", attempt: 3, error: "required table missing" }));
      const converter = FakeConverter.succeeding();
      const message = new FakeMessage(JOB_ID, 4);

      await handle(message, store, converter, new FakeClock());

      expect(converter.startCount).toBe(0);
      expect(store.writes).toHaveLength(0);
      expect(message.ackCount).toBe(1);
    });

    it("converts the file, writes down where it landed, and closes the job out", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.succeeding();
      const message = new FakeMessage(JOB_ID);

      await handle(message, store, converter, new FakeClock());

      // It should say it's working before it starts working.
      expect(store.writes[0]?.status).toBe("running");
      expect(converter.startCount).toBe(1);
      expect(converter.last.inputKey).toBe(job().inputKey);

      const final = store.snapshot(JOB_ID);
      expect(final?.status).toBe("succeeded");
      expect(final?.attempt).toBe(1);
      expect(final?.outputKey).toBe(converter.last.outputKey);
      expect(message.ackCount).toBe(1);
      expect(message.retryCount).toBe(0);
    });

    it("puts the message back when the converter has one bad run", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.failingWith(flakyCrash());
      const message = new FakeMessage(JOB_ID, 1);

      await handle(message, store, converter, new FakeClock());

      expect(message.retryCount).toBe(1);
      expect(message.ackCount).toBe(0);
      expect(store.snapshot(JOB_ID)?.status).not.toBe("failed");
    });
  });

  describe(`${name} — the stuff that broke in production`, () => {
    // "An export may be 10 GB to 40 GB and take tens of minutes."
    // A thirty second budget means no export has ever finished.
    it("gives an export more than thirty seconds to do a job that takes half an hour", async () => {
      const store = new InMemoryJobStore();
      store.seed(exportJob());
      const converter = FakeConverter.pending();
      const clock = new NoteTakingClock();
      const message = new FakeMessage(JOB_ID);

      const running = handle(message, store, converter, clock);
      await converter.started();

      const budget = Math.max(...clock.asked);
      expect(budget).toBeGreaterThanOrEqual(45 * 60_000);

      converter.last.complete();
      await running;

      expect(store.snapshot(JOB_ID)?.status).toBe("succeeded");
    });

    // "A timed-out subprocess may continue running unless its owner terminates
    //  and reaps it." Walking away from a 2 GB JVM is how a worker runs itself
    //  out of memory one job at a time.
    it("actually kills the converter when it runs out of time", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.pending();
      const clock = new FakeClock();
      const message = new FakeMessage(JOB_ID, 1);

      const running = handle(message, store, converter, clock);
      await converter.started();
      clock.expireTimeouts();
      await running;

      expect(converter.last.killed).toBe(true);
      expect(message.retryCount).toBe(1);
    });

    // "An invalid database exits quickly with code 2 and a message such as
    //  'required table missing'." No amount of retrying fixes a broken file,
    //  and the customer is waiting to be told it's broken.
    it("gives up on a broken file straight away instead of chewing through retries", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.failingWith(brokenFile());
      const message = new FakeMessage(JOB_ID, 1);

      await handle(message, store, converter, new FakeClock());

      const final = store.snapshot(JOB_ID);
      expect(final?.status).toBe("failed");
      expect(final?.error).toContain("required table missing");
      expect(message.ackCount).toBe(1);
      expect(message.retryCount).toBe(0);
    });

    // "Two deliveries for the same job can reach different workers less than
    //  100 ms apart." Both read 'queued' before either writes 'running'.
    it("only lets one worker run the job when the same message shows up twice at once", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.succeeding();
      const clock = new FakeClock();

      store.holdReads();
      const first = handle(new FakeMessage(JOB_ID, 1), store, converter, clock);
      const second = handle(new FakeMessage(JOB_ID, 1), store, converter, clock);
      expect(store.heldReads).toBe(2);
      store.releaseReads();
      await Promise.all([first, second]);

      expect(converter.startCount).toBe(1);
      expect(store.snapshot(JOB_ID)?.attempt).toBe(1);
    });

    // "A slow attempt may finish after another attempt has already published a
    //  result." The customer gets the wrong package and nothing looks wrong.
    it("won't stomp on a result another worker already published", async () => {
      const store = new InMemoryJobStore();
      store.seed(job());
      const converter = FakeConverter.pending();
      const message = new FakeMessage(JOB_ID, 1);

      const running = handle(message, store, converter, new FakeClock());
      await converter.started();

      // Meanwhile, a second attempt finishes and publishes.
      store.seed(job({ status: "succeeded", attempt: 2, outputKey: "jobs/job-1/attempts/2/result.json" }));
      const writesBefore = store.writes.length;

      converter.last.complete();
      await running;

      expect(store.writes).toHaveLength(writesBefore);
      const final = store.snapshot(JOB_ID);
      expect(final?.attempt).toBe(2);
      expect(final?.outputKey).toBe("jobs/job-1/attempts/2/result.json");
    });

    // The handler counts its own attempts and then deletes the message. The DLQ
    // we built to catch these never sees a thing, so nobody can replay them.
    it("hands a job that keeps failing back to the queue so it reaches the DLQ", async () => {
      const store = new InMemoryJobStore();
      store.seed(job({ attempt: 2 }));
      const converter = FakeConverter.failingWith(flakyCrash());
      const message = new FakeMessage(JOB_ID, 3);

      await handle(message, store, converter, new FakeClock());

      expect(message.retryCount).toBe(1);
      expect(message.ackCount).toBe(0);
    });
  });
}