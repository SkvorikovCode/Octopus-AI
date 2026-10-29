#!/usr/bin/env bash
# Points the AUR package at a release: version, checksum of its .deb, .SRCINFO.
#   scripts/aur-bump.sh 0.3.0               # downloads the release's .deb
#   scripts/aur-bump.sh 0.3.0 path/to.deb   # uses a local copy (the same file)
# Needs makepkg (Arch) for .SRCINFO. Publishing: packaging/aur/README.md.
set -euo pipefail

version="${1:?usage: scripts/aur-bump.sh <version> [deb]}"
version="${version#v}"
dir="$(cd "$(dirname "$0")/.." && pwd)/packaging/aur/octopus-ai-bin"
url="https://github.com/SkvorikovCode/Octopus-AI/releases/download/v${version}/Octopus_${version}_amd64.deb"

deb="${2:-}"
if [[ -z $deb ]]; then
  deb="$(mktemp --suffix=.deb)"
  trap 'rm -f "$deb"' EXIT
  curl -fsSL -o "$deb" "$url"
fi
sum="$(sha256sum "$deb" | cut -d' ' -f1)"

sed -i \
  -e "s/^pkgver=.*/pkgver=${version}/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=.*/sha256sums=('${sum}')/" \
  "$dir/PKGBUILD"
(cd "$dir" && makepkg --printsrcinfo > .SRCINFO)

echo "octopus-ai-bin ${version}: sha256 ${sum}"
