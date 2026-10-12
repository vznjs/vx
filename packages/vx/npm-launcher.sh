#!/bin/sh
# npm launcher for a vx command: the published package's `bin`. It execs the
# platform package's prebuilt binary straight from the shell, since Node's
# own start was ~40 ms of every `vx` call made through node_modules/.bin
# (45-53 ms against 12-14 ms for `vx --version`, 2026-10-12). Anything it
# cannot settle (no sibling platform package, musl, Yarn PnP, an unknown
# platform) goes to launcher.cjs beside it, which resolves through Node and
# owns the fallbacks and the error messages.

# The real file: npm's .bin entry is a symlink to it. Parameter expansion,
# not dirname/basename, and no `cd`: each fork is a millisecond, and the
# kernel resolves `<dir>/..` through a symlinked directory (pnpm's
# node_modules/@vzn/vx) to its real parent on its own.
self=$0
hops=0
while [ -L "$self" ] && [ "$hops" -lt 40 ]; do
  hops=$((hops + 1))
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=${self%/*}/$target ;;
  esac
done
case $self in
  */*) here=${self%/*} ;;
  *) here=. ;;
esac
base=${here##*/}
scope=${here%/*}
scope=${scope##*/}

key=
loader=
case $(uname -sm) in
  'Linux x86_64') key=linux-x64 loader=/lib64/ld-linux-x86-64.so.2 ;;
  'Linux aarch64' | 'Linux arm64') key=linux-arm64 loader=/lib/ld-linux-aarch64.so.1 ;;
  'Darwin x86_64') key=darwin-x64 ;;
  'Darwin arm64') key=darwin-arm64 ;;
esac

# The platform package sits beside this one under npm, pnpm and Bun
# (node_modules/@vzn/vx-<key>), or under this package's own node_modules
# when npm could not hoist it. The glibc binary needs its loader (musl
# has none); launcher.cjs names that cause.
if [ -n "$key" ] && { [ -z "$loader" ] || [ -e "$loader" ]; }; then
  for bin in "$here/../$base-$key/$base" "$here/node_modules/$scope/$base-$key/$base"; do
    if [ -x "$bin" ]; then exec "$bin" "$@"; fi
  done
fi
exec node "$here/launcher.cjs" "$@"
