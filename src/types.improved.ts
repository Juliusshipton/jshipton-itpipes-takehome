// The starter interfaces plus the two changes the revised handler needs.
// Everything not listed here is re-exported from types.ts unchanged, so a
// handler written against the starter types still accepts these.
//
//   Job.jobType              Picks the timeout per workload. Optional because
//                            rows written before the field existed have none;
//                            the handler falls back to the input key prefix.
//   JobStore.putIfUnchanged  Conditional write. Stands in for a DynamoDB PutItem
//                            with a ConditionExpression on the row as it was
//                            read. Every state transition goes through it, so a
//                            second or late worker loses instead of overwriting.

import type { Job as StarterJob, JobStore as StarterJobStore } from "./types.js";

export type { Clock, Converter, JobStatus, QueueMessage, RunningConversion } from "./types.js";

export type JobType = "import" | "export";

export interface Job extends StarterJob {
  jobType?: JobType;
}

export interface JobStore extends StarterJobStore {
  get(id: string): Promise<Job | undefined>;
  put(job: Job): Promise<void>;
  /** Writes `next` only if the stored row still equals `expected`. Resolves to whether it won. */
  putIfUnchanged(next: Job, expected: Job): Promise<boolean>;
}
