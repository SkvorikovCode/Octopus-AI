# AUR package

`octopus-ai-bin` repackages the `.deb` of a GitHub release for Arch Linux and its derivatives (Omarchy, CachyOS, EndeavourOS):

- `octopus-ai` and its engine go in `/usr/lib/octopus-ai/`, with `/usr/bin/octopus-ai` linked to the first. The app finds the engine next to itself.
- The desktop entry is `octopus-ai.desktop`, named after the window class, and the icons go in `hicolor`.
- The built-in updater stays off, as for every system package: `pacman` updates it.

## After each release

A release must include `Octopus_<version>_amd64.deb` (the `linux-x64` job of `release.yml`).

```sh
scripts/aur-bump.sh <version>              # without the leading v
git -C packaging/aur/octopus-ai-bin diff   # pkgver, sha256sums, .SRCINFO
```

The script sets `pkgrel=1`. A packaging-only fix to a version already on the AUR
needs `pkgrel` bumped by hand in both files.

Commit the change here, then push the two files to the AUR.

## Publishing

Not published yet. The committed `PKGBUILD` still carries the `SKIP` checksum and
points at `v0.2.1`, whose release has no `.deb`; the first push must wait for a
release that carries one, and follow a `scripts/aur-bump.sh` run.

The first time, with an [AUR account](https://aur.archlinux.org/register) and its SSH key:

```sh
git clone ssh://aur@aur.archlinux.org/octopus-ai-bin.git ~/aur/octopus-ai-bin
```

Then for every release:

```sh
cp packaging/aur/octopus-ai-bin/{PKGBUILD,.SRCINFO} ~/aur/octopus-ai-bin/
cd ~/aur/octopus-ai-bin && git commit -am "Update to <version>" && git push
```

Users install it with `yay -S octopus-ai-bin`, or on Omarchy with `omarchy pkg aur add octopus-ai-bin`.

## Testing a change

In a clean container, with a `.deb` built locally. Without the release signing key, turn the updater files off:

```sh
scripts/fetch-engine.sh x86_64-unknown-linux-gnu
npx tauri build --config src-tauri/tauri.release.conf.json --config '{"bundle":{"createUpdaterArtifacts":false}}' --bundles deb
```

Then, substituting the version the build produced:

```sh
ver=0.2.1   # the version in src-tauri/tauri.conf.json
scripts/aur-bump.sh "$ver" "src-tauri/target/release/bundle/deb/Octopus_${ver}_amd64.deb"
cp "src-tauri/target/release/bundle/deb/Octopus_${ver}_amd64.deb" packaging/aur/octopus-ai-bin/
docker run --rm -v "$PWD/packaging/aur/octopus-ai-bin:/pkg:ro" archlinux:latest bash -c '
  pacman -Syu --noconfirm --needed base-devel namcap &&
  useradd -m b && cp -r /pkg /home/b/pkg && chown -R b /home/b/pkg &&
  su b -c "cd ~/pkg && makepkg -d --noconfirm" &&
  pacman -U --noconfirm /home/b/pkg/*.pkg.tar.zst &&
  namcap /home/b/pkg/*.pkg.tar.zst; ldd /usr/lib/octopus-ai/octopus-ai | grep "not found"'
```

`-d` builds without the dependencies installed; installing the package then pulls in exactly the declared ones; `ldd` then lists any library they do not cover.

`makepkg` uses the `.deb` lying next to the PKGBUILD instead of downloading it. Do not commit that file.

The bump above wrote the *local* `.deb`'s checksum into the tracked `PKGBUILD`
and `.SRCINFO`. Revert them before committing:

```sh
git checkout packaging/aur/octopus-ai-bin/{PKGBUILD,.SRCINFO}
```
