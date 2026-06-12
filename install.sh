#!/usr/bin/env sh
# vx installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
#
# Env overrides:
#   VX_INSTALL_DIR   destination dir (default: $HOME/.local/bin)
#   VX_VERSION       specific tag to install (default: latest)

set -eu

repo="vznjs/vx"
install_dir="${VX_INSTALL_DIR:-$HOME/.local/bin}"
version="${VX_VERSION:-latest}"

# --- platform detection -----------------------------------------------------

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux | darwin) ;;
  *)
    printf 'vx: unsupported OS: %s\n' "$os" >&2
    exit 1
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *)
    printf 'vx: unsupported architecture: %s\n' "$arch" >&2
    exit 1
    ;;
esac

asset="vx-${os}-${arch}"

# --- download ---------------------------------------------------------------

if [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${asset}"
else
  url="https://github.com/${repo}/releases/download/${version}/${asset}"
fi

mkdir -p "$install_dir"
dest="${install_dir}/vx"

printf 'vx: downloading %s -> %s\n' "$asset" "$dest"
if ! curl -fSL --progress-bar "$url" -o "$dest.tmp"; then
  printf 'vx: download failed (%s)\n' "$url" >&2
  rm -f "$dest.tmp"
  exit 1
fi
chmod +x "$dest.tmp"
mv "$dest.tmp" "$dest"

# Later upgrades: re-run this script, or just `vx upgrade`.
# --- post-install hint ------------------------------------------------------

printf '\nvx: installed %s\n' "$("$dest" --version 2>/dev/null || echo "(version check failed)")"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    printf '\nAdd %s to your PATH:\n  export PATH="%s:$PATH"\n' "$install_dir" "$install_dir" ;;
esac
