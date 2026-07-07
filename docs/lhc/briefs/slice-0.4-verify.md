# Verification task: audit Slice 0.4 concurrency harness (verify, don't fix)

You are the verifier. Do not modify or delete existing files; do not `git commit`. You MAY
run the tests and the standalone load runner (they write only to temp dirs), and you may
run read-only shell commands.

The implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-0.4.md`.
Under audit: `packages/lhc-host/test/concurrency/` (harness, test, run-load.ts) and
`docs/lhc/findings/concurrency.md`.
SDK source (read-only): `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc`.

## What to check

1. **Is the load real?** Read the harness: is intake genuinely concurrent across threads
   (interleaved at the Promise level), or effectively sequential (e.g. awaiting each
   thread's batch in a loop, which would make the whole validation vacuous)? Same question
   for how drains overlap with ongoing intake.
2. **Do the assertions actually assert?** Cross-thread contamination check — does it
   compare real per-thread content, or something that would pass trivially? Leftover-work
   and derivation-state checks — via real `inspect.health`/queue reads or via bookkeeping
   the harness itself maintains (self-confirming)?
3. **The headline finding:** "SDK scheduling is per-thread with no global inference cap;
   observed max concurrency == thread count." Verify against the SDK scheduler source that
   this is architecturally true, not an artifact of the fake callbacks. Is the
   recommended host cap of 8 reasoned from anything, or arbitrary? (Arbitrary-but-stated
   is acceptable; unstated reasoning is a concern.)
4. **Run it.** Default-scale test via the package test script (should be green in tens of
   seconds) and one larger standalone run (e.g. LHC_LOAD_THREADS=20). Do observed numbers
   roughly match the findings doc?
5. **Real-inference smoke.** The brief required confirming the flag-gated `claude -p` path
   works at least once; the implementer skipped that. Run it ONCE at the smallest scale
   (LHC_LOAD_REAL_INFERENCE=1, 2 threads) — it calls the paid claude CLI once or twice,
   which is authorized. Report whether it works or what breaks.
6. **Findings doc honesty.** Does the not-tested list match reality (process crash
   mid-drain, registry contention, etc.)? Any overclaim?

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, with specifics (file/line,
observed vs claimed numbers).
