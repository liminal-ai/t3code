# CCode Long macOS test build

CCode Long is the Claude-focused desktop app. This page covers the internal
Apple Silicon macOS test builds produced from the CCode Long release workflow.
The current test builds do not yet contain LHC integration.

CCode Long installs alongside T3 Code without touching it: it has its own
bundle identifier (`ai.liminal.ccodelong`), its own URL scheme
(`ccode-long://`), its own application data and state directories, its own
keychain entry, and its own update feed. Installing or removing it leaves any
T3 Code installation and its data unchanged.

## Before installing

- Use an Apple Silicon Mac.
- Keep any existing Claude Code, CC-LHC, or T3 Code installations unchanged.
- Download the DMG, `SHA256SUMS`, and `RELEASE-MANIFEST.json` from the same
  GitHub prerelease.
- Confirm that the manifest names the expected source commit and reports
  `product: "CCode Long"`, `darwin`, and `arm64`.
- Read `codeSeal`, `developerIdSigned`, `notarized`, and `approvedFor` in the
  manifest before deciding where to install:

  | Manifest                                                                                            | Meaning                                                                            | Where it may be used     |
  | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
  | `codeSeal: "developer-id"`, `developerIdSigned: true`, `notarized: true`, `approvedFor: "work"`     | Developer ID signed and notarized; verified by CI from the ZIP and the mounted DMG | Work Mac or personal Mac |
  | `codeSeal: "adhoc"`, `developerIdSigned: false`, `notarized: false`, `approvedFor: "personal-test"` | Valid ad-hoc seal only; Gatekeeper will not accept it as a verified developer      | Personal Mac only        |

Verify the downloaded files from Terminal:

```bash
cd ~/Downloads
shasum -a 256 -c SHA256SUMS
```

Do not install an artifact if verification fails.

## User-level installation

1. Open the DMG.
2. Create `~/Applications` if it does not exist.
3. Copy **CCode Long** into `~/Applications`.
4. Eject the DMG.
5. Open the app from `~/Applications`.

This path does not require administrator access and does not install npm,
Node, a compiler, Homebrew, or Xcode.

## Which builds are safe where

**Work-safe builds** (`approvedFor: "work"`) are signed with a Developer ID
Application certificate and notarized by Apple. CI verifies the seal, the
Developer ID authority, the expected team, hardened runtime, the stapled
notarization ticket, and Gatekeeper acceptance from both the ZIP and the
mounted DMG before the manifest is written. Gatekeeper accepts them without
any override.

**Do not bypass Gatekeeper on a work Mac.** If macOS reports a build from this
project as damaged or unverified on a work machine, stop and report it; do not
remove quarantine attributes, use `Open Anyway`, or otherwise work around the
block. Follow your workplace security policy.

**Personal-test builds** (`approvedFor: "personal-test"`, `codeSeal: "adhoc"`)
carry a valid ad-hoc code seal, so macOS reports them as from an unverified
developer rather than as damaged. They are not Developer ID signed, not
notarized, and not approved for workplace use. Use them only on a Mac you own,
only after `shasum -a 256 -c SHA256SUMS` passes, and only through the standard
macOS Privacy & Security **Open Anyway** flow.

### Older T3 Code (Nightly) build `claude-desktop-v0.0.0-nightly.20260816.3`

That earlier prerelease predates CCode Long. It was built without any code
signature and is **not approved for workplace use**; its manifest reports
`signed: false` and `notarized: false`. On a quarantined download macOS
reports it as **damaged** and only offers to move it to Trash. On a personal
Mac only, after checksum verification, it can be run by clearing the
quarantine flag on the copied bundle:

```bash
xattr -dr com.apple.quarantine "$HOME/Applications/T3 Code (Nightly).app"
```

Do this only for a checksum-verified download, only on a Mac you own, and
never on a work Mac. Prefer a CCode Long build.

## First-run check

1. Authenticate through the supported Claude flow.
2. Open a disposable project.
3. Create a thread and send a small prompt.
4. Run one harmless tool action and exercise its approval prompt.
5. Wait for the turn to settle.
6. Quit the app normally.
7. Relaunch it and resume the same thread.

Record the app version, macOS version, and exact failure text if any step does
not work.

## Where CCode Long keeps its state

- Application data: `~/Library/Application Support/ccode-long`
- Server state, settings, and logs: `~/.ccode-long/userdata` (override with
  `CCODE_LONG_HOME`; `T3CODE_HOME` is ignored by CCode Long)
- Updates: the `ccode-long` channel only. The update track cannot be switched
  to a T3 Code channel.

CCode Long never reads or migrates T3 Code data from
`~/Library/Application Support/T3 Code (Nightly)`, `t3code-nightly`, or
`~/.t3`.

## Update

Quit the app. Verify the new release files, then replace the app bundle in
`~/Applications`. Application state must remain intact.

## Remove the app

Quit the app and move `~/Applications/CCode Long.app` to Trash. This removes
the application bundle only. It intentionally preserves user state for
reinstallation and diagnosis.

Do not remove application state, Claude sessions, CC-LHC data, or T3 Code
data unless a separate recovery procedure explicitly identifies the exact
paths.
