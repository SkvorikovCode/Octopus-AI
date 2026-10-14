# Releasing

Releases are cut from a **version tag**, never from ordinary commits. Pushing to `main` only runs the
CI checks; the `Release` workflow starts when a tag like `v0.1.0` is pushed, builds the app, and
attaches it to a **draft** GitHub Release. Nothing is public until a maintainer publishes the draft.

Release builds bundle the agent engine (oh-my-pi) so the app works out of the box. The pinned version
and checksum live in `engine.lock`; the workflow downloads it with `scripts/fetch-engine.sh`.

Current targets: macOS on Apple Silicon, unsigned (a preview, with install notes in the release
body). Releases are **not** marked as pre-releases: the app looks for updates at
`releases/latest/download/latest.json`, and GitHub's "latest" skips pre-releases.

## In-app updates

The app checks for updates five seconds after launch, every six hours, and from the menu
(**Octopus → Check for Updates…**). The release workflow signs the update archive and publishes
`latest.json` next to the `.dmg`. The app accepts only archives signed with the key whose public
half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

The private key and its password live in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the maintainer keeps a copy in `~/.tauri/`). **If the key is
lost, installed apps can never update again**: users would have to download the next version by
hand. Back it up somewhere safe.

## Steps

1. **Bump the version** in all three places, in one PR titled `chore(release): vX.Y.Z`:
   - `package.json` (`version`)
   - `src-tauri/Cargo.toml` (`version`; run `cargo check` so `Cargo.lock` follows)
   - `src-tauri/tauri.conf.json` (`version`)
2. **Merge it** once CI is green.
3. **Tag the merge commit on `main`** and push the tag:
   ```sh
   git switch main && git pull
   git tag -a v0.1.0 -m "Octopus AI v0.1.0"
   git push origin v0.1.0
   ```
4. **Watch the `Release` run** in the Actions tab. It refuses to build if the tag is not on `main` or
   if the tag and the three version fields disagree.
5. **Review the draft** under Releases: download the `.dmg`, open it on a clean Mac, check the notes,
   then press **Publish release**. Publishing is what makes installed apps see the update.

A broken tag is fixed by deleting the draft and the tag (`git push --delete origin v0.1.0`),
correcting `main`, and tagging again.

## Updating the bundled engine

1. Pick the new release at https://github.com/can1357/oh-my-pi/releases and read its notes.
2. Put the new version and the SHA-256 of `omp-darwin-arm64` (from that release's `SHA256SUMS.txt`) in
   `engine.lock`.
3. Run `scripts/fetch-engine.sh` locally (it verifies the checksum), then try the app against it with
   `OMP_BIN=src-tauri/binaries/omp-aarch64-apple-darwin npm run tauri dev`.
4. Ship it in a normal PR; the next release picks it up.

## Building a release locally

```sh
scripts/fetch-engine.sh
npm run tauri build -- --target aarch64-apple-darwin --config src-tauri/tauri.release.conf.json
```

## Unsigned builds on macOS

Without an Apple Developer ID the app is **ad-hoc signed** (`bundle.macOS.signingIdentity: "-"`
in `tauri.conf.json`). That seal matters: a bundle with no proper signature (only the linker's) is
reported by Gatekeeper as **"damaged, move to Trash"** with no way to open it. With the ad-hoc seal
macOS says it cannot verify the developer and offers **Open Anyway** under System Settings →
Privacy & Security (macOS 15+ removed the right-click → Open shortcut). **Hardened runtime stays off** (`hardenedRuntime: false`): it enforces library validation, and
once the engine is re-signed ad-hoc it loses its developer's team ID, so it may no longer load the
native module it unpacks into `~/.omp/natives/` on first run ("Failed to load pi_natives native
addon"). Hardened runtime only matters for notarization; turn it back on together with a real
Developer ID. Check a build with:

```sh
codesign --verify --deep --strict --verbose=2 Octopus.app   # must say "valid on disk"
```

## Not done yet

- Code signing and notarization (needs an Apple Developer account and CI secrets). Until then macOS
  shows a Gatekeeper warning and the release notes explain how to open the app.
- Windows and Linux builds.
- Automatic changelog / version bumps (Conventional Commits make this possible later, for example
  with release-please).
