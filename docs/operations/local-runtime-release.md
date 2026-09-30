# Local HAPI runtime releases

A version number or clean checkout does not identify the deployed patch set.
Before building, read the live `/etc/hapi/current-release.json`, the retained
`/etc/hapi/local-runtime-contract.json`, the active Hub/Runner units and their
actual executable images. Preserve both source fixes and dependency patches.

The September 30 incident had three distinct failures: a newer build dropped
NewSession's historical-error separation; fresh Codex startup was incorrectly
limited by interactive and ordinary Hub RPC deadlines; a rebuild omitted the
uncommitted iOS 15 GFM dependency patch. Do not treat hiding an error, increasing
one timeout, or passing Chrome tests as full repair.

## Required sequence

1. Start from the deployed runtime source commit, not arbitrary upstream/main.
   Inventory every active patch, including dependency patches, systemd guards
   and older still-running process images. Resolve differences before building.
2. Commit all intended source and dependency changes. Preserve unrelated work.
   Run every check named in `scripts/verify-release-inventory.py`; keep logs,
   exact source SHA, toolchain and build hashes. An equivalent upstream fix may
   replace a local patch only after its behavior tests pass.
3. Build Hub and CLI together. Run an isolated compiled canary, the HTTP asset
   check, and a real fresh Codex spawn. Keep a verified rollback Hub/CLI pair.
4. Prepare a receipt using schema `hapi-release-inventory/v1`, immutable
   `sourceCommit`, `checks` keyed by REQUIRED_CHECKS with value `passed`, and
   `artifacts` keyed hub/cli/rollbackHub/rollbackCli, each with absolute `path`
   and SHA256. Keep evidence links with the receipt. The receipt is a reviewed
   attestation; the checker does not prove that tests were executed.
5. Before activation, run `python3 scripts/verify-release-inventory.py RECEIPT`.
   After Hub readiness run `python3 scripts/verify-launch-ui.py`. Check entry
   AND preload JS; the iOS-incompatible expression was in a vendor bundle.
6. Install via versioned paths and atomic replacement, retaining named backups.
   Use `renameat2(RENAME_EXCHANGE)` for a live CLI binary so old process images
   retain a named inode. Update the runtime contract's installed hash/device/
   inode without overwriting the separately attested active Runner identity.
   Never restart a Runner carrying sessions to load new code. Its environment
   and watchdog remain those loaded at process startup until safe rotation.
7. Verify served bytes, original session integrity, actual new-session webhook
   and native rollout, and existing-patch regressions. A desktop browser or
   user-agent string is not physical iOS 15 verification. Clean up only empty
   test sessions after checking for user activity. Record activation limits.

On hapi, the maintained memory/clock runtime line as of September 30 is
`fix/new-session-diagnostics-20260930` at
`c7e5db52a9c8466878a035891a4263e7c5ea5c52`. The user fork main contains this task's
UI/startup/iOS fixes but is NOT an interchangeable memory/clock runtime base.
Use the current receipt if it supersedes this historical reference.

The startup inventory guard rejects artifact drift or missing required checks
and rollback files. The existing HTTP guard rejects omitted UI/iOS patches.
Do not remove either guard or the npm-upgrade refusal to get a build deployed.
