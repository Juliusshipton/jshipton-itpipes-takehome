import type { QueueMessage } from "../../src/types.improved.js";

/** QueueMessage that counts ack() and retry() calls. Stands in for an SQS delivery. */
export class FakeMessage implements QueueMessage {
  ackCount = 0;
  retryCount = 0;

  constructor(
    public jobId: string,
    public receiveCount = 1,
  ) {}

  async ack(): Promise<void> {
    this.ackCount++;
  }

  async retry(): Promise<void> {
    this.retryCount++;
  }
}
