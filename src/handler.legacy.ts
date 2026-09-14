// Verbatim from ASSIGNMENT.md, "Starter worker". This file is the control in the
// experiment and is frozen. The only change is the type-only import below.

import type { Clock, Converter, JobStore, QueueMessage } from "./types.js";

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

  const attempt = job.attempt + 1;
  await store.put({ ...job, status: "running", attempt });

  const outputKey = `jobs/${job.id}/result.json`;
  const conversion = converter.start(job.inputKey, outputKey);

  try {
    await Promise.race([
      conversion.completion,
      clock.timeout(30_000),
    ]);

    await store.put({
      ...job,
      status: "succeeded",
      attempt,
      outputKey,
    });
    await message.ack();
  } catch (error) {
    if (message.receiveCount >= 3) {
      await store.put({
        ...job,
        status: "failed",
        attempt,
        error: String(error),
      });
      await message.ack();
      return;
    }
    await message.retry();
  }
}
