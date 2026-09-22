// The gate's first task: refuse a Bun below `MIN_BUN` before a shard starts.
// `bin.ts` only WARNS below the floor (most of vx works there, and a warning
// is what the measurement supports for a user), but a gate on an old Bun
// spends an hour producing verdicts that are the runtime's: on 1.3.11 the
// 2026-09-19 container saw a shard die with SIGILL one run in eight, three
// "flaky" tests, and symlink tripwires that could not fail (`Bun.Glob` did
// not descend a symlinked directory), all of which 1.4.2 cleared (STATUS
// items 566, 572). A verdict from below the floor is not a verdict, so the
// gate stops here, in well under a second, and says where the binary is.
import { isUnsupportedBun, MIN_BUN, unsupportedBunMessage } from '../src/util/bun-version.js'

/** The release asset that downloads where `bun upgrade` is refused (a proxy that answers 403 for bun.sh). */
export const RELEASE_ASSET = (
  version: string,
  platform = process.platform,
  arch = process.arch,
): string =>
  `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'aarch64' : 'x64'}.zip`

/** The version CI pins (`.github/workflows/ci.yml`); the gate asks for the floor, and names this as the known-good build. */
export const CI_BUN = '1.4.2'

export function floorVerdict(version: string): { ok: boolean; message: string } {
  if (!isUnsupportedBun(version))
    return { ok: true, message: `bun ${version} (floor ${MIN_BUN.join('.')})` }
  return {
    ok: false,
    message:
      `${unsupportedBunMessage(version)}\n` +
      `The gate refuses to run below the floor: a shard that dies or a tripwire that cannot fail is the runtime's verdict, not the diff's.\n` +
      `Where \`bun upgrade\` is refused, the release asset downloads through a proxy: ${RELEASE_ASSET(CI_BUN)} — unzip it and put that directory first on PATH.`,
  }
}

if (import.meta.main) {
  const verdict = floorVerdict(Bun.version)
  if (verdict.ok) {
    process.stdout.write(`${verdict.message}\n`)
  } else {
    process.stderr.write(`${verdict.message}\n`)
    process.exitCode = 1
  }
}
