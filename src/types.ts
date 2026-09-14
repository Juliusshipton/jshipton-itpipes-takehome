// Verbatim from ASSIGNMENT.md, "Starter worker". Do not edit.

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
