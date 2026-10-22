#!/usr/bin/env bash
# Downloads the pinned agent engine for release builds and verifies its checksum.
# Usage: scripts/fetch-engine.sh [target-triple]   (default: rustc's host)
# Output (all git-ignored):
#   src-tauri/binaries/omp-<target-triple>   the sidecar Tauri bundles
#   src-tauri/engine-licenses/               licence texts that must ship with it
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../engine.lock
source "$root/engine.lock"

target="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$target" in
  aarch64-apple-darwin)     asset=omp-darwin-arm64; want="$ENGINE_SHA256_DARWIN_ARM64" ;;
  x86_64-unknown-linux-gnu) asset=omp-linux-x64;    want="$ENGINE_SHA256_LINUX_X64" ;;
  *) echo "No pinned engine for target $target (see engine.lock)" >&2; exit 1 ;;
esac

base="https://github.com/$ENGINE_REPO/releases/download/v$ENGINE_VERSION"
bin_dir="$root/src-tauri/binaries"
lic_dir="$root/src-tauri/engine-licenses"
mkdir -p "$bin_dir" "$lic_dir"

dest="$bin_dir/omp-$target"
echo "Downloading engine v$ENGINE_VERSION ($asset)..."
curl -fL --retry 3 -o "$dest" "$base/$asset"

if command -v sha256sum >/dev/null; then
  got="$(sha256sum "$dest" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$dest" | cut -d' ' -f1)"
fi
if [ "$got" != "$want" ]; then
  rm -f "$dest"
  echo "Checksum mismatch for $asset" >&2
  echo "  expected $want" >&2
  echo "  got      $got" >&2
  exit 1
fi
chmod +x "$dest"

curl -fL --retry 3 -o "$lic_dir/oh-my-pi-LICENSE" "$base/LICENSE"
curl -fL --retry 3 -o "$lic_dir/oh-my-pi-THIRD-PARTY-NOTICES.txt" "$base/THIRD-PARTY-NOTICES.txt"

echo "Engine ready: $("$dest" --version)"
