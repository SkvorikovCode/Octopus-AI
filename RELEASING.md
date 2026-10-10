# Releasing

Releases are cut from a **version tag**, never from ordinary commits. Pushing to `main` only runs the
CI checks; the `Release` workflow starts when a tag like `v0.1.0` is pushed, builds the app, and
attaches it to a **draft** GitHub Release. Nothing is public until a maintainer publishes the draft.

Release builds bundle the agent engine (oh-my-pi) so the app works out of the box. The pinned version
and checksum live in `engine.lock`; the workflow downloads it with `scripts/fetch-engine.sh`.

Current targets: macOS on Apple Silicon, unsigned (marked as a preview, with install notes in the
release body). Everything before 1.0 is published as a pre-release.

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
   then press **Publish release**.

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

## Not done yet

- Code signing and notarization (needs an Apple Developer account and CI secrets). Until then macOS
  shows a Gatekeeper warning and the release notes explain how to open the app.
- Windows and Linux builds.
- Automatic changelog / version bumps (Conventional Commits make this possible later, for example
  with release-please).
