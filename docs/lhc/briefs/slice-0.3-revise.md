# Revision request: Slice 0.3 findings doc (verifier findings)

Your swap probe was verified: probe validity, the BRONZE-HERON-77 headline claim, the
rebuilt-file shape, and both failure-mode claims all PASS with evidence. The REVISE is
about `docs/lhc/findings/claude-swap.md` being implementation-ready for Slice 2.2 without
re-derivation. **Doc-only revision — do not run any new provider sessions, do not modify
code.** Address these:

1. **Exact persisted cursor.** State the exact `resume_cursor_json` value the server-level
   flip must write, as the adapter-shaped JSON object (read
   `apps/server/src/provider/Layers/ClaudeAdapter.ts` `updateResumeCursor` ~line 1447 for
   the authoritative field set — e.g. whether `threadId`/`turnCount` belong in it). Replace
   the current "probably reset/adjust" language (~lines 120-125) with a ruling.
2. **`resumeSessionAt`.** Explicit ruling: cleared on flip, or set to the rebuilt file's
   leaf assistant UUID — say which and why (what does the adapter do with a stale
   `resumeSessionAt` pointing at a uuid not present in the rebuilt file?).
3. **Upsert gotcha.** Document that `ProviderSessionDirectory.upsert` preserves the
   existing cursor when the field is omitted
   (`apps/server/src/provider/Services/ProviderSessionDirectory.ts:139-142` per the
   verifier), so the flip must actively write the new cursor AFTER the live session is
   stopped/quiesced — add this to the server-level integration checklist.
4. **Race caveats.** Note that uuid + file-existence prevalidation does not cover
   (a) rollout file deleted between check and first turn, and (b) reaper/live-session
   races (a session reviving or writing around the flip). List both as Slice 2.2 checklist
   items, not solved problems.
5. **Wording nuance.** Where the doc says "cc-lhc minimal shape", clarify it means the
   rebuild-core line shape (`buildRolloutLines`); cc-lhc's full writer ALSO appends a
   sessions-index entry (`write-rebuilt.ts:86-97`), which this probe proved unnecessary
   for resume — keep the "index not required" conclusion, just make the provenance precise.

Constraints: edits to `docs/lhc/findings/claude-swap.md` only. No commits. Report the diff
summary when done.
