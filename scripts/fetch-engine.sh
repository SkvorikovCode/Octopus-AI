#!/usr/bin/env bash
# Downloads the pinned agent engine for release builds and verifies its checksum.
# Output (all git-ignored):
#   src-tauri/binaries/omp-aarch64-apple-darwin   the sidecar Tauri bundles
#   src-tauri/engine-licenses/                    licence texts that must ship with it
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../engine.lock
source "$root/engine.lock"

base="https://github.com/$ENGINE_REPO/releases/download/v$ENGINE_VERSION"
bin_dir="$root/src-tauri/binaries"
lic_dir="$root/src-tauri/engine-licenses"
mkdir -p "$bin_dir" "$lic_dir"

dest="$bin_dir/omp-aarch64-apple-darwin"
echo "Downloading engine v$ENGINE_VERSION (darwin-arm64)..."
curl -fL --retry 3 -o "$dest" "$base/omp-darwin-arm64"

got="$(shasum -a 256 "$dest" | cut -d' ' -f1)"
if [ "$got" != "$ENGINE_SHA256_DARWIN_ARM64" ]; then
  rm -f "$dest"
  echo "Checksum mismatch for omp-darwin-arm64" >&2
  echo "  expected $ENGINE_SHA256_DARWIN_ARM64" >&2
  echo "  got      $got" >&2
  exit 1
fi
chmod +x "$dest"

curl -fL --retry 3 -o "$lic_dir/oh-my-pi-LICENSE" "$base/LICENSE"
curl -fL --retry 3 -o "$lic_dir/oh-my-pi-THIRD-PARTY-NOTICES.txt" "$base/THIRD-PARTY-NOTICES.txt"

echo "Engine ready: $("$dest" --version)"
