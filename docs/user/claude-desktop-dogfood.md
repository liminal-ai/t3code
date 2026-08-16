# Claude-only desktop dogfood

This is an internal Apple Silicon macOS build. It contains the Claude-only T3
desktop baseline. It does not contain LHC integration.

## Before installing

- Use an Apple Silicon Mac.
- Keep the existing Claude Code and CC-LHC installations unchanged.
- Download the DMG, `SHA256SUMS`, and `RELEASE-MANIFEST.json` from the same
  GitHub prerelease.
- Confirm that the manifest names the expected source commit and reports
  `darwin` and `arm64`.

Verify the downloaded files from Terminal:

```bash
cd ~/Downloads
shasum -a 256 -c SHA256SUMS
```

Do not install an artifact if verification fails.

## User-level installation

1. Open the DMG.
2. Create `~/Applications` if it does not exist.
3. Copy **T3 Code (Nightly)** into `~/Applications`.
4. Eject the DMG.
5. Open the app from `~/Applications`.

This path does not require administrator access and does not install npm,
Node, a compiler, Homebrew, or Xcode.

The first dogfood build is unsigned and not notarized. macOS or corporate
security software can refuse it. If macOS offers **Open Anyway** in Privacy &
Security, use that supported system flow. Do not bypass a workplace security
policy.

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

## Update

Quit the app. Verify the new release files, then replace the app bundle in
`~/Applications`. Application state must remain intact.

## Remove the app

Quit the app and move `~/Applications/T3 Code (Nightly).app` to Trash. This
removes the application bundle only. It intentionally preserves user state for
reinstallation and diagnosis.

Do not remove application state, Claude sessions, or CC-LHC data unless a
separate recovery procedure explicitly identifies the exact paths.
