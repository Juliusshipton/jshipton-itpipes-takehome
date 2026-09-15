import type { Converter, RunningConversion } from "../../src/types.improved.js";

/** The error a converter run produces, carrying the process exit code. */
export class ConverterExitError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ConverterExitError";
  }
}

/** What a started conversion should do. */
export type ConversionOutcome =
  | { kind: "succeed" }
  | { kind: "fail"; error: unknown }
  | { kind: "pending" };

/** A conversion the test settles by hand, or that the converter settles on start. */
export class FakeConversion implements RunningConversion {
  readonly completion: Promise<void>;
  killed = false;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;

  constructor(
    readonly inputKey: string,
    readonly outputKey: string,
  ) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  complete(): void {
    this.resolveCompletion();
  }

  fail(error: unknown): void {
    this.rejectCompletion(error);
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.rejectCompletion(new ConverterExitError(143, "terminated by owner"));
  }
}

/**
 * Converter that never starts a process. Records every start() and applies
 * the configured outcome to each conversion it hands out.
 */
export class FakeConverter implements Converter {
  readonly conversions: FakeConversion[] = [];
  private readonly firstStart: Promise<void>;
  private signalStarted!: () => void;

  constructor(private readonly outcome: ConversionOutcome = { kind: "pending" }) {
    this.firstStart = new Promise<void>((resolve) => {
      this.signalStarted = resolve;
    });
  }

  static succeeding(): FakeConverter {
    return new FakeConverter({ kind: "succeed" });
  }

  static failingWith(error: unknown): FakeConverter {
    return new FakeConverter({ kind: "fail", error });
  }

  static pending(): FakeConverter {
    return new FakeConverter({ kind: "pending" });
  }

  start(inputKey: string, outputKey: string): FakeConversion {
    const conversion = new FakeConversion(inputKey, outputKey);
    this.conversions.push(conversion);
    if (this.outcome.kind === "succeed") conversion.complete();
    if (this.outcome.kind === "fail") conversion.fail(this.outcome.error);
    this.signalStarted();
    return conversion;
  }

  get startCount(): number {
    return this.conversions.length;
  }

  get last(): FakeConversion {
    const last = this.conversions[this.conversions.length - 1];
    if (!last) throw new Error("no conversion has been started");
    return last;
  }

  /** Resolves once start() has been called, so a test can act mid-conversion. */
  started(): Promise<void> {
    return this.firstStart;
  }
}
