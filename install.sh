#!/usr/bin/env sh
# vx installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
#
# Env overrides:
#   VX_INSTALL_DIR      destination dir (default: $HOME/.local/bin)
#   VX_VERSION          specific tag to install (default: latest)
#   VX_NO_MODIFY_PATH   set to 1 to skip updating your shell profile

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
# --- PATH setup ---------------------------------------------------------------

printf '\nvx: installed %s\n' "$("$dest" --version 2>/dev/null || echo "(version check failed)")"

# A printed hint alone is not enough — piped installers scroll past and the
# very next `vx` is "command not found". Persist the PATH into the login
# shell's profile (opt out with VX_NO_MODIFY_PATH=1), like bun/rustup/uv do.
case ":$PATH:" in
  *":$install_dir:"*) ;; # already reachable — nothing to do
  *)
    export_line="export PATH=\"$install_dir:\$PATH\""
    if [ "${VX_NO_MODIFY_PATH:-0}" = "1" ]; then
      printf '\nAdd %s to your PATH:\n  %s\n' "$install_dir" "$export_line"
    else
      # $SHELL is the user's LOGIN shell even when this script runs under
      # `curl | sh` — pick its profile, not the profile of /bin/sh.
      case "$(basename "${SHELL:-sh}")" in
        zsh)
          profile="${ZDOTDIR:-$HOME}/.zshrc"
          line="$export_line"
          ;;
        fish)
          profile="$HOME/.config/fish/conf.d/vx.fish"
          line="fish_add_path \"$install_dir\""
          ;;
        bash)
          profile="$HOME/.bashrc"
          line="$export_line"
          ;;
        *)
          profile="$HOME/.profile"
          line="$export_line"
          ;;
      esac
      if [ -f "$profile" ] && grep -Fqs "$line" "$profile"; then
        printf '\nvx: %s already configures PATH — restart your shell to use vx.\n' "$profile"
      elif mkdir -p "$(dirname "$profile")" 2>/dev/null \
        && printf '\n# vx\n%s\n' "$line" >>"$profile" 2>/dev/null; then
        printf '\nvx: added %s to PATH in %s\n' "$install_dir" "$profile"
        printf 'Restart your shell, or run this once in the current one:\n  %s\n' "$export_line"
      else
        # Unwritable profile — fall back to the manual hint.
        printf '\nAdd %s to your PATH:\n  %s\n' "$install_dir" "$export_line"
      fi
    fi
    ;;
esac
