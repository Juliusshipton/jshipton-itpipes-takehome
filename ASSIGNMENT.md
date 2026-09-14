# Platform Homework: Legacy File Conversion Service

Welcome, and thanks for taking the time to work through this.

This exercise is built around a real problem our platform team is actively working through — evolving a file-conversion service under real production load, not a problem invented for interviews. We're less interested in whether you land on one "correct" design and more interested in how you think: how you rank competing risks, what you'd deliberately leave alone, and how clearly you can explain that reasoning to a teammate.

The logistics are below — take a look, and don't hesitate to note where you'd go next if you had more time. That's a useful signal too.

## How this works

- Timebox: 2 to 3 hours total. Stop when you reach the limit and record what you would do next.

- Use any tools you want, **AI use is encouraged**. In NOTES.md, tell us what you asked it to do, what you accepted, and what you rejected or corrected.

- Any language is fine. TypeScript is preferred because it is our go-forward stack, but use the language in which you can make and defend good decisions.

- The problem statement is incomplete on purpose. State assumptions instead of trying to invent hidden requirements.

- **Send your submission to the group on the onsite calendar invite at least 24 hours before the onsite.**

- Send a repository link (make the repo public) or zip containing:

- DESIGN.md with the design review.

- Your revised worker and focused tests.

- README.md with exact commands for running the tests.

- NOTES.md with assumptions, remaining risks, where you stopped, and how you used AI.

- The onsite includes a 60-minute design and code review; during that session we'll introduce new evidence and ask how your design responds. Expect a substantial part of that hour on deployment, metrics, and observability.

## Context

ITpipes builds software for CCTV pipe inspection. Municipalities and contractors have years of inspection history in legacy Microsoft Access exchange databases. We need a cloud service that imports those databases into JSON and exports JSON plus media into packages that existing customer software can consume.

## Facts about the workload

- Callers are backend services owned by other ITpipes teams.

- Callers submit jobs through an HTTP API and pass S3 references. File bytes do not travel through the API.

- An import reads one database file between 10 MB and 2 GB. It normally takes seconds to several minutes and may produce up to 500 MB of JSON.

- An export reads JSON plus a media map from S3 and produces a zip containing a database, videos, and images. A package may be 10 GB to 40 GB and take tens of minutes.

- Normal volume is about 1,000 jobs per day, roughly 80% imports and 20% exports. Customer onboarding creates bursts: a bad evening delivers about 3,000 jobs at once in the same mix.

- Imports and exports currently share one work queue and one worker fleet.

- The import converter is a TypeScript library. The export writer is a vendor JVM subprocess. You may wrap either converter but may not change its implementation.

- A running conversion needs about 2 GB of memory and is single-threaded.

- Jobs have four externally visible states: queued, running, succeeded, and failed.

- Results are stored in S3. Job metadata is retained for 90 days.

- Some consumers request an optional completion webhook, but they can also poll the job API.

## Current proposed architecture

The team has proposed the following first version:

- API Gateway and Lambda accept jobs.

- DynamoDB stores job metadata.

- One SQS queue and DLQ feed ECS Fargate workers.

- Workers run as 1 vCPU / 4 GB Fargate tasks, and each worker processes up to 10 messages concurrently.

- The worker fleet scales from zero based on queue depth.

- Workers store results under jobs/{jobId}/result and then mark the job succeeded.

- The API accepts a caller-provided idempotency key.

- The same worker code handles imports and exports.

- Completion webhooks are retried with backoff.

Treat this proposal as provisional. You are allowed to keep it, change parts of it, or reject it.

## Part 1: Design review (60 to 90 minutes)

Write a short design review, aiming for two pages plus an optional diagram.

Cover:

- **Risk ranking.** The three risks you would address first, ranked, with the failure or customer impact behind each one. Also name two things you would deliberately leave alone, and the evidence or threshold that would cause you to revisit each.

- **Smallest changes.** The minimum set of changes you would make before releasing v1.

- **Job lifecycle.** One import and one export end to end: state ownership, retry boundaries, result publication, and how the caller learns the outcome.

- **Operations, deployment, and observability.** This section carries the same weight as your architecture. Three operational signals for the first dashboard or alert set: for each, the metric, where it is emitted, a rough threshold, and the action it should cause. Then one paragraph, no more: how a change reaches production (pipeline stages, in whatever tooling you would pick), how you would detect a bad release, and how you would stop or reverse it.

- **Sizing and cost.** Size the fleet for the onboarding evening (3,000 jobs in the stated mix) and estimate, roughly, the monthly AWS bill at normal volume. Name the biggest line item and the single change that would cut it the most. Show your arithmetic; precision is not the point, reasoning is.

You do not need to design authentication, multi-region operation, the exchange file schema, or the user interface. You also do not need to write Terraform or pipeline config. You do need to describe how the infrastructure is structured, deployed, and observed: what lives in code, what the pipeline stages are, and where the metrics and alarms in your signals section actually come from. Naming tools is fine; we are grading the shape of the operating story, not the syntax.

## Part 2: Code review and repair (60 to 90 minutes)

The code below is a simplified version of the worker. It is intentionally incomplete. Review it as if it were in a pull request, together with the workload facts and the production observations further down; some risks are only visible when you read all three.

Your task:

- Identify the correctness risks you see.

- Choose the one or two risks you believe are most urgent.

- Make the smallest code changes that address those risks.

- Add focused tests that would have failed before your change.

- Record what you did not fix and why.

You may change the interfaces when necessary, but explain the reason. In-memory implementations are fine. You do not need AWS credentials, Docker, or a working JVM.

## Starter worker

This is the per-message handler, not the whole task. The task's poll loop (not shown) receives up to 10 messages and invokes handle() concurrently. Treat the interfaces as the seams to the job store, the queue, and the converters.

```ts
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  outputKey?: string;
  error?: string;
}

export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  put(job: Job): Promise<void>;
}

export interface QueueMessage {
  jobId: string;
  receiveCount: number;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export interface RunningConversion {
  completion: Promise<void>;
  kill(): Promise<void>;
}

export interface Converter {
  start(inputKey: string, outputKey: string): RunningConversion;
}

export interface Clock {
  timeout(ms: number): Promise<never>;
}

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
```

## Production observations

The team has seen these events in testing:

- Two deliveries for the same job can reach different workers less than 100 ms apart.

- An invalid database exits quickly with code 2 and a message such as "required table missing."

- A converter sometimes exits with code 137 and succeeds on a later run.

- A timed-out subprocess may continue running unless its owner terminates and reaps it.

- A slow attempt may finish after another attempt has already published a result.

These observations are evidence, not a list of required fixes. Decide what matters most within the timebox.

## What we evaluate

We care about how you prioritize risk, reason about competing work and partial failure, make safe changes, operate what you build, and explain your decisions. We do not award points for the number of AWS services, document length, or code volume.
