# Notes

## How I used AI

I had three agents (GPT, Claude, and Gemini) each write a design review from the assignment on their own. Then I gave each one all three reviews and asked it to cross check the others and produce a single unified design. I compared the three unified reviews and went with Claude's as the base for DESIGN.md, mostly because it showed its arithmetic and tied every fix back to a production observation. GPT's unified review was too thin to use.

For the code I did the same thing: one shared set of scenarios, then a revised handler from each agent. Only Claude and Gemini produced something that ran. Things I rejected or corrected along the way:

- Gemini's handler killed the most recently started conversion on the worker instead of its own. With ten handlers running at once that can kill another job's process.
- Gemini's handler reached into test-only helpers (a synchronous store snapshot, the fake converter's last conversion) and imported a test file from production code. The fencing only worked because the in-memory store is synchronous.
- Both handlers read `error.code`, but the converter error carries `exitCode`. Neither would have classified a broken file as permanent. One word fix, but the tests are what caught it.
- The agents disagreed on what happens after the third failed delivery. I went with letting SQS own the retry count so failures actually reach the DLQ.

The tests are the reason I trust any of this. Both handlers run against the same scenarios and the diff in results is the whole story.

## Interface changes

`src/types.ts` is the starter, untouched. `src/types.improved.ts` extends two of its interfaces and re-exports the rest. Because the additions are a superset, the legacy handler still compiles and runs against the same fakes.

**`Job.jobType?: "import" | "export"`**
The handler needs to know which workload it has to pick a sane timeout. Fifteen minutes for an import, ninety for an export, instead of thirty seconds for both. It is optional so rows written before the field existed still load; the handler falls back to the input key prefix.

**`JobStore.putIfUnchanged(next, expected): Promise<boolean>`**
A conditional write. It stands in for a DynamoDB `PutItem` with a condition on the row as it was read. Every state transition in the revised handler goes through it: claiming the attempt, publishing the result, marking a permanent failure. If another worker got there first the write is refused and the handler acks and stops. This is what fixes the duplicate delivery and the slow attempt overwriting a published result. The in-memory store in `tests/utils/store.ts` implements it as a compare and swap.

Not an interface change, but related: each attempt writes to `jobs/{jobId}/attempts/{n}/result.json` instead of a single key, so a late attempt can never overwrite the bytes of one that already published. The job record's `outputKey` is the pointer, and swapping it is the conditional write above.
