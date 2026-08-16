# Claude-focused desktop host roadmap

Status: working product roadmap, 2026-08-16. This document records direction and
release gates. It does not claim that planned capabilities have shipped.

## Product thesis

Build the best cross-platform desktop experience for Claude coding:

- preserve the useful daily workflows of Claude Code;
- present them through a polished, understandable desktop interface;
- use supported Anthropic interfaces rather than private protocol emulation;
- make Long Horizon Context (LHC) the durable context and continuity engine;
- make installation, updates, recovery, and long-running work reliable;
- add new behavior only when it clearly improves the core Claude workflow.

The first target user is a developer who uses Claude Code at work and needs a
self-contained macOS application that installs without administrator access.
The immediate success criterion is daily internal use of test builds, not broad market launch.

## Product principles

1. **Claude first.** Do not carry a universal provider product into the first
   release. Keep a narrow runtime adapter so SDK changes do not reach the UI.
2. **Behavioral compatibility.** Preserve the workflows users rely on without
   copying private Claude Code internals, prompts, protocols, binaries, or
   branding.
3. **LHC is the differentiator.** Durable history, retrieval, context aging,
   compaction, and continuity must feel like part of the product rather than an
   administration console.
4. **The interface earns attention.** Essential state is visible. Advanced
   controls and receipts use progressive disclosure. Help appears at the point
   of need.
5. **Effect remains the lifecycle grammar.** Pure domain logic stays ordinary
   TypeScript. Stateful, concurrent, fallible, or resource-owning work uses
   Effect with typed errors, scoped resources, cancellation, and test Layers.
6. **Canonical state has one owner.** T3 owns UI and orchestration state. LHC
   owns canonical conversation and context history. A Claude transcript is an
   executable session projection, not an independent source of truth.
7. **No hidden client build.** Normal installation requires no npm registry,
   Node installation, compiler, Xcode, Homebrew, or administrator access.
8. **Prove the artifact users receive.** Source tests are necessary but do not
   replace clean installation, launch, lifecycle, update, and recovery tests on
   the exact packaged artifact.

## Architectural direction

The intended product has four main layers:

1. **Desktop UI and application shell** from current T3 Code.
2. **Claude runtime adapter** around the supported Claude Agent SDK and any
   documented Claude integration surfaces the product needs.
3. **Host services** for projects, worktrees, tools, permissions, terminals,
   diffs, checkpoints, background processes, and runtime control.
4. **LHC** for append-only capture, turns, derivations, served views, retrieval,
   compaction, continuity receipts, and recovery.

T3's local database remains the control plane for projects, worktrees,
commands, approvals, questions, runtime sessions, checkpoints, diffs, pinning,
archiving, and UI activity. LHC should become authoritative for messages,
turns, tool activity, model context, derivations, and retrieval. Existing T3
message tables can become replaceable UI projections after LHC-backed resume is
proven.

The Claude runtime adapter must remain small. Provider-neutral abstractions are
kept only when they protect the UI and orchestration core from SDK churn. They
must not preserve unused multi-provider complexity.

## Current verified baseline

The current work exists on the isolated Claude-only product branch. It has not
been released or deployed.

Verified locally:

- current upstream T3 Code is the base;
- Claude is the only registered and visible runtime;
- new threads and internal text generation default to Claude;
- Codex, Cursor, Grok, OpenCode, and ACP runtime implementations were removed;
- two unused provider protocol packages were removed;
- remaining workspaces type-check;
- sequential workspace test suites passed;
- the production desktop build passed;
- the Electron launch smoke test passed;
- the first Linux nightly AppImage built successfully;
- a second bounded Linux AppImage build completed and produced a recorded
  SHA-256 checksum;
- a direct real Claude Agent SDK probe resumed with the same session ID and
  remembered the prior turn;
- focused nightly workflow checks passed independent review.

Not yet proven:

- the complete platform artifact matrix has not finished from one immutable
  source revision;
- the full T3 orchestration and packaged UI lifecycle has not completed launch,
  thread create, send, settle, exit, and resume;
- no LHC runtime, storage, capture, retrieval, or compact behavior is included
  in this checkpoint;
- no macOS artifact from this branch has been installed on Lee's work machine.

The local Linux host lacks FUSE 2 and GTK 3, so it could build and inspect the
AppImage but could not complete a packaged GUI launch. This is a host
qualification limitation. It is not evidence that the AppImage launches or
fails on a supported desktop Linux system.

## Phase 0: preserve and qualify the Claude-only baseline

Goal: establish a small, known-good product base before adding LHC.

- Finish the interrupted nightly artifact qualification.
- Run focused tests for every changed runtime, settings, desktop, release, and
  migration path.
- Build and inspect the packaged application, not only unpacked development
  output.
- Remove remaining user-visible non-Claude surfaces that are reachable in the
  product.
- Preserve narrow generic contracts that serve lifecycle isolation or tests.
- Record exact source revision, toolchain, artifacts, and checksums.

Exit gate: the Claude-only app launches from a clean profile and no known code
blocker prevents the first real-runtime test build.

## Phase 1: prove the real Claude workflow

Goal: prove that the supported Claude runtime can carry an ordinary coding
session before LHC changes session ownership.

Required scenario:

1. Launch the packaged app from a clean user profile.
2. Authenticate through a supported Claude path.
3. Open a project and create a thread.
4. Send a prompt and receive streaming output.
5. Execute a tool and resolve a permission request.
6. Reach a settled turn with durable receipts.
7. Exit the application normally.
8. Relaunch and resume the same thread.
9. Confirm that the UI, runtime, and transcript agree on the session state.

Failures must remain visible and typed. The host must not hide a failed resume
by creating an unrelated thread.

## Phase 2: add the minimum complete LHC path

Goal: make the desktop app a credible replacement for workplace CC-LHC use.

Minimum capability:

- bind every Claude session to one durable LHC thread;
- capture exact user, assistant, reasoning, tool-call, tool-result, usage, and
  lifecycle events available through supported surfaces;
- preserve stable turn and message identifiers;
- expose bounded turn and message retrieval;
- build and inspect an LHC served view;
- perform manual compact and safe resume;
- observe provider pressure and support automatic governance at a validated
  host seam;
- preserve tool correlation, permissions, effort, and runtime continuity;
- emit durable receipts for preparation, installation, refusal, and recovery;
- fail closed when a served request or resume projection is invalid;
- prevent CC-LHC and the desktop host from writing the same thread at once.

The first CCode Long test build may use isolated LHC state. Existing CC-LHC history
must move only through a tested import or explicit ownership-transfer process.
Never point both products at the same writable database.

## Phase 3: make context understandable

Goal: replace the current text-heavy control experience with a useful context
surface.

The primary view should show:

- current provider pressure;
- current served-context size;
- compact trigger and target;
- active band allocation;
- last compact outcome;
- LHC health;
- one clear primary action.

Advanced details such as derivation health, receipts, recovery artifacts, and
raw policy belong behind expandable sections.

Band allocation should offer named profiles before raw percentages:

- **Balanced:** 25 / 25 / 25 / 25;
- **Recent-heavy:** 30 / 30 / 20 / 20;
- **Deep history:** more brief and detailed capacity;
- **Maximum continuity:** more smooth and full capacity;
- **Custom:** explicit percentages with validation and a plain-language
  preview.

A maturity-aware profile can be explored after explicit profiles work. It must
remain visible and must not silently replace a user's choice.

## Phase 4: Claude Code workflow compatibility

Goal: make the desktop app feel like Claude Code with a better interface.

High-priority workflows:

- project and persistent-session management;
- resume and continuation;
- file edits, diffs, and checkpoints;
- terminal and tool execution;
- permission modes and approval review;
- plans, plan-mode transitions, and plan artifacts;
- `/goal` behavior and durable goal progress;
- skills and MCP;
- subagents and delegated work;
- images and attachments;
- keyboard-first commands and discoverable help;
- interruption, cancellation, retry, and recovery;
- dynamic workflows that change course as evidence arrives.

Plan mode and `/goal` should be tested against real Claude Code behavior. If
the current T3 implementation limits them, record the limitation before
redesigning it. Do not invent a parallel workflow model without evidence that
the supported Claude surfaces are insufficient.

## Phase 5: asynchronous process management

Goal: match Claude's ability to manage long-running and concurrent work without
orphaned processes or lying UI state.

Required behavior:

- start foreground and background commands with explicit ownership;
- stream output without flooding the conversation projection;
- distinguish running, quiet, blocked, completed, failed, cancelled, and
  detached states;
- reconnect after UI or transport interruption;
- cancel one owned process without killing unrelated processes;
- preserve process receipts across application restart where possible;
- prevent stale process state from appearing active;
- surface completion once, without repeated alert noise;
- apply bounded output and retrieval for large logs;
- settle the agent turn only when the runtime contract says work is complete.

Tests should use receipts and drains rather than sleeps or polling. Packaged
test builds must cover a real long-running command, interruption, background
completion, relaunch, and cleanup.

## Phase 6: no-admin macOS test-build distribution

Goal: let Lee install and update the product on a managed work Mac without
administrator privileges or access to missing Nexus packages.

Primary path:

- produce an Apple Silicon artifact in CI for the first internal release;
- bundle Electron, application code, JavaScript dependencies, and native
  dependencies;
- require no runtime npm install, compiler, Xcode, or Homebrew;
- install the application under `~/Applications`;
- place any optional CLI launcher under a user-owned path such as
  `~/.local/bin`;
- download over HTTPS from a versioned GitHub release;
- verify SHA-256 before installation;
- preserve user state during update and uninstall;
- provide explicit install, update, verify, rollback, and uninstall behavior;
- keep CC-LHC installed as an independent fallback during early internal releases.

Corporate-readiness evidence:

- exact source revision and version manifest;
- checksums for every downloadable file;
- dependency and license inventory;
- software bill of materials when practical;
- build and smoke-test receipts;
- supported operating systems and architectures;
- known limitations and support policy;
- signing and notarization status stated truthfully.

### Product identity

CCode Long registers with macOS as its own application, never as a variant of
T3 Code. Build and runtime identity both come from one source,
`packages/shared/src/desktopProductIdentity.ts`, selected by the
`-ccode-long.YYYYMMDD.N` version discriminator: display name `CCode Long`,
bundle identifier and AppUserModelId `ai.liminal.ccodelong`, URL and renderer
scheme `ccode-long`, executable `ccode-long`, artifact prefix `CCode-Long`,
updater channel `ccode-long`, userData `ccode-long`, and state home
`~/.ccode-long` (override `CCODE_LONG_HOME`; `T3CODE_HOME` is not honoured).
A CCode Long build never adopts `T3 Code (Nightly)` or `t3code-nightly`
userData, `~/.t3` state, the T3 keychain entry, T3 URL registration, the T3
updater feed, or the T3 single-instance lock, and it does not migrate or
import T3 data. Its update channel is pinned; the T3 `latest`/`nightly` feeds
in the same release repository are refused.

### Signing and notarization

Signing and notarization are required for any work-safe release. They require
a Developer ID Application certificate and App Store Connect notarization
credentials (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and the `APPLE_TEAM_ID` variable) in
the release repository. The CCode Long macOS ARM64 test-release workflow fails
when they are missing rather than falling back to an unsigned build, verifies
Developer ID authority, team, hardened runtime, stapled ticket, and `spctl`
acceptance from both the ZIP and the mounted DMG, and derives the manifest's
`codeSeal`, `developerIdSigned`, `notarized`, and `approvedFor` values from
those checks. Passkey (Associated Domains) entitlements and a provisioning
profile are optional and only apply when that configuration is present.

For personal testing without Apple credentials the workflow can be dispatched
in `adhoc` mode: the packager applies an ad-hoc code seal (`--adhoc-sign`,
mutually exclusive with `--signed`), CI verifies `codesign --verify --deep
--strict` and that the signature is exactly ad hoc from the ZIP and the DMG,
and the manifest reports `codeSeal: "adhoc"`, `developerIdSigned: false`,
`notarized: false`, `approvedFor: "personal-test"`. Ad-hoc builds are never
work-safe and never claim Gatekeeper acceptance.

An unsigned artifact (such as the earlier T3 Code (Nightly)
`nightly.20260816.3`) is home-only: it is reported as damaged by Gatekeeper
because the mutated bundle keeps Electron's broken inherited seal, and it must
not be used on a work Mac. Work Macs must never bypass Gatekeeper.

Fallback source-build path:

- frozen lockfile;
- exact Node and package-manager versions;
- vendored package store for dependencies absent from the corporate Nexus;
- prebuilt native dependencies where local compilation is restricted;
- checksummed offline build bundle;
- instructions that never write into system-owned paths.

## Phase 7: release cadence and promotion

Use two channels:

- **Test:** frequent prereleases for Lee and internal testers.
- **Stable:** promotion of an already-tested immutable artifact after lifecycle,
  installation, recovery, and platform gates pass.

Do not rebuild between certification and promotion. A release receipt should
identify the source revision, build run, artifact checksums, test matrix, known
limitations, and promotion decision.

The first internal release is successful when Lee can install it without
administrator access, complete real work with Claude, resume it later,
and provide workflow feedback. It does not need every Claude Code feature.

## Later product: Pi-only desktop host

Claude remains the first product. A later Pi desktop application should be a
separate focused host, not another provider option inside the Claude product.

Potential reusable foundation:

- Electron and web shell;
- typed contracts and streaming transport;
- durable thread and command state;
- Effect service and lifecycle infrastructure;
- projects, terminals, diffs, approvals, and artifacts;
- LHC capture, retrieval, compaction, and continuity;
- packaging, update, and observability systems.

Pi-specific design should preserve the spirit of extensions through explicit
frontend contributions for commands, tools, panels, views, settings,
permissions, and lifecycle events. The Claude product should not be distorted
in advance to support this.

After both Claude and Pi fit the same narrow lifecycle contracts, extract a
small agent-application reference architecture. Generalize shared lifecycle,
streaming, storage, and capability boundaries rather than recreating a broad
provider framework.

## Explicit non-goals for the first release

- universal multi-provider support;
- private Claude Code protocol emulation;
- exact parity with every experimental Claude Code feature;
- simultaneous CC-LHC and desktop ownership of one thread;
- a generic agent framework before two real products prove the abstractions;
- a public release claim based only on source tests;
- system-wide installation that requires administrator privileges.

## Issue-shaping guide

When this roadmap is converted into Linear features and stories, use bounded
vertical slices:

1. Claude-only baseline qualification.
2. Real Claude fresh-state lifecycle.
3. LHC lineage and exact capture.
4. LHC retrieval and served-view inspection.
5. Manual compact and resume.
6. Automatic context governance.
7. Context UX and band profiles.
8. Plan mode, `/goal`, and dynamic workflow parity.
9. Asynchronous process lifecycle.
10. No-admin macOS packaging and installer.
11. Internal test release, feedback, and promotion gates.
12. Cross-platform hardening.

Each story should own its production-path acceptance evidence. Shared unit
tests are not sufficient proof of packaged lifecycle behavior.
