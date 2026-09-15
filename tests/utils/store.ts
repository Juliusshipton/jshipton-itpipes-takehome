import type { Job, JobStore } from "../../src/types.improved.js";

/**
 * JobStore backed by a Map. Stands in for DynamoDB. Records every write so a
 * test can read the history, and can hold reads so two handlers can be forced
 * to both read a job before either one writes.
 */
export class InMemoryJobStore implements JobStore {
  readonly writes: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private holdingReads = false;
  private heldReaders: Array<() => void> = [];

  /** Writes a row directly, as the API or another worker would. Not recorded. */
  seed(job: Job): void {
    this.jobs.set(job.id, { ...job });
  }

  /** The row as it is right now. */
  snapshot(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async get(id: string): Promise<Job | undefined> {
    const job = this.snapshot(id);
    if (this.holdingReads) {
      await new Promise<void>((resolve) => this.heldReaders.push(resolve));
    }
    return job;
  }

  async put(job: Job): Promise<void> {
    this.writes.push({ ...job });
    this.jobs.set(job.id, { ...job });
  }

  /**
   * Writes `next` only if the row still equals `expected`. Stands in for a
   * DynamoDB PutItem whose ConditionExpression is the row as it was read.
   */
  async putIfUnchanged(next: Job, expected: Job): Promise<boolean> {
    if (!sameRow(this.jobs.get(next.id), expected)) return false;
    await this.put(next);
    return true;
  }

  /** From now on, get() reads the row but does not answer until releaseReads(). */
  holdReads(): void {
    this.holdingReads = true;
  }

  get heldReads(): number {
    return this.heldReaders.length;
  }

  releaseReads(): void {
    this.holdingReads = false;
    const readers = this.heldReaders;
    this.heldReaders = [];
    for (const resume of readers) resume();
  }
}

function sameRow(a: Job | undefined, b: Job | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.inputKey === b.inputKey &&
    a.status === b.status &&
    a.attempt === b.attempt &&
    a.outputKey === b.outputKey &&
    a.error === b.error &&
    a.jobType === b.jobType
  );
}
