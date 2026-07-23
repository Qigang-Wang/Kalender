import { nextDeepReconcileRange, shouldRunDeepReconcile } from "./imap-sync";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const firstRange = nextDeepReconcileRange(2_000);
assert(
  firstRange?.minimumUid === 1_301 && firstRange.maximumUid === 1_800,
  "deep reconciliation starts immediately before the recent UID window",
);
assert(firstRange.nextBeforeUid === 1_300, "deep reconciliation advances toward older UIDs");

const secondRange = nextDeepReconcileRange(2_000, firstRange.nextBeforeUid);
assert(
  secondRange?.minimumUid === 801 && secondRange.maximumUid === 1_300,
  "the saved cursor resumes at the next non-overlapping range",
);

const finalRange = nextDeepReconcileRange(600, 20);
assert(
  finalRange?.minimumUid === 1 && finalRange.maximumUid === 20 && finalRange.nextBeforeUid === 400,
  "a completed audit cycle wraps back to the newest deep range",
);
assert(!nextDeepReconcileRange(200), "mailboxes covered by the recent window need no deep range");
const boundedRange = nextDeepReconcileRange(2_000, undefined, 1_600);
assert(
  boundedRange?.minimumUid === 1_600 && boundedRange.maximumUid === 1_800 && boundedRange.nextBeforeUid === 1_800,
  "deep reconciliation does not scan below the oldest locally indexed UID",
);
assert(!nextDeepReconcileRange(2_000, undefined, 1_900), "folders with only recent indexed mail need no deep audit");

const now = Date.parse("2026-07-23T12:00:00.000Z");
assert(shouldRunDeepReconcile(undefined, now), "a folder without an audit timestamp is eligible");
assert(
  shouldRunDeepReconcile("2026-07-23T11:29:59.999Z", now),
  "a folder is eligible after the deep reconciliation interval",
);
assert(
  !shouldRunDeepReconcile("2026-07-23T11:30:00.001Z", now),
  "a recently audited folder is throttled",
);

console.log("IMAP deep reconciliation state tests passed");
