// Revised worker handler.
//
// Same shape as the starter. Three behavioural changes, all driven by the
// production observations in ASSIGNMENT.md:
//
//   1. The timeout is derived from the job type instead of being a fixed 30s,
//      and a conversion that runs out of time is terminated rather than
//      abandoned.
//   2. Every state transition is a conditional write, so a second or late
//      worker loses instead of overwriting.
//   3. Failures are classified. A malformed input fails once; everything else
//      goes back to the queue and lets SQS's maxReceiveCount own the ceiling.
//
// Known gap, deliberate: a job whose message ends up in the DLQ stays in
// `running` until the redrive process resolves it. Adding a `retrying` state
// is a caller-visible API change and is out of scope for this repair.

import type {
  Clock,
  Converter,
  Job,
  JobStore,
  QueueMessage,
  RunningConversion,
} from "./types.improved.js";

// Imports take seconds to several minutes; exports take tens of minutes.
// These are ceilings for a stuck process, not expected durations.
const IMPORT_TIMEOUT_MS = 15 * 60_000;
const EXPORT_TIMEOUT_MS = 90 * 60_000;

// Exit codes the converter uses for input it will never be able to read.
// Retrying these burns capacity and delays telling the customer their file is bad.
const PERMANENT_EXIT_CODES = new Set([2]);

export async function handle(
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
): Promise<void> {
  const job = await store.get(message.jobId);

  if (!job) {
    await message.ack();
    return;
  }

  if (job.status === "succeeded" || job.status === "failed") {
    await message.ack();
    return;
  }

  // Claim the attempt. If another worker got here first, the record no longer
  // matches what we read, the write is refused, and we stop without converting.
  const attempt = job.attempt + 1;
  const claimed: Job = { ...job, status: "running", attempt };

  const won = await store.putIfUnchanged(claimed, job);
  if (!won) {
    await message.ack();
    return;
  }

  // Each attempt writes to its own key, so a slow attempt can never overwrite
  // the bytes of one that already published. The job record's outputKey is the
  // pointer, and swapping it is the conditional write below.
  const outputKey = `jobs/${job.id}/attempts/${attempt}/result.json`;
  const conversion = converter.start(job.inputKey, outputKey);

  let timedOut = false;
  const deadline = clock.timeout(timeoutFor(job)).catch((error) => {
    timedOut = true;
    throw error;
  });

  try {
    await Promise.race([conversion.completion, deadline]);
  } catch (error) {
    // Terminate before releasing the message. An abandoned conversion keeps its
    // memory and its subprocess, and the next delivery lands on a worker that
    // has less room than the last one did.
    if (timedOut) {
      await terminate(conversion);
    }

    if (isPermanent(error)) {
      await store.putIfUnchanged(
        { ...claimed, status: "failed", error: String(error) },
        claimed,
      );
      await message.ack();
      return;
    }

    // Transient. Hand it back and let the queue count the attempts, so a job
    // that keeps failing ends up in the DLQ instead of being deleted.
    await message.retry();
    return;
  }

  // Publish. Guarded on the job still being the attempt we claimed: if another
  // attempt finished first, this write is refused and our output is discarded.
  await store.putIfUnchanged({ ...claimed, status: "succeeded", outputKey }, claimed);
  await message.ack();
}

function timeoutFor(job: Job): number {
  return typeOf(job) === "export" ? EXPORT_TIMEOUT_MS : IMPORT_TIMEOUT_MS;
}

function typeOf(job: Job): "import" | "export" {
  if (job.jobType) return job.jobType;
  // Fallback for records written before jobType existed.
  return job.inputKey.startsWith("exports/") ? "export" : "import";
}

function isPermanent(error: unknown): boolean {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" && PERMANENT_EXIT_CODES.has(code);
}

async function terminate(conversion: RunningConversion): Promise<void> {
  try {
    await conversion.kill();
  } catch {
    // Already gone. Nothing to reap.
  }
}