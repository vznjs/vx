// The OS-sandbox availability gate, defined ONCE.
//
// Two suites need it — tests/sandbox-runtime.test.ts (19 tests) and
// verify.test.ts's input-completeness block (2) — and as two copies the
// rule had already drifted: one file's comment claimed "we assert
// availability rather than skipping ... local dev hosts fail loudly",
// which the code never did, while the other claimed a clean skip. Two
// copies of a rule are how they disagree about what the rule is.
//
// WHY THIS IS MORE THAN TIDYING: a skipped suite reports GREEN. These 21
// tests cover the isolation boundary `sandbox: {}` promises and the
// `--verify=inputs` input-completeness proof — the code where a wrong
// answer is a security answer. `describe.skipIf` on a dependency CI is
// supposed to provide means a broken install deletes that coverage under
// a green check, and the console.warn scrolls past in a 2600-test run.
//
// The CI workflow's own guard is NOT a substitute, and the gap is
// measured rather than assumed. `probeSandbox` has four failure paths
// (unsupported platform, SRT's dependency check, the bwrap exec probe,
// and the SRT import itself); the workflow hard-fails on exactly one of
// them, the raw `bwrap ... /bin/true` line in "Diagnose sandbox
// availability". Running both suites with socat off PATH — bwrap intact,
// so that guard still exits 0 — reported `35 pass / 21 skip / 0 fail`,
// exit 0.
//
// So CI sets VX_REQUIRE_SANDBOX=1 and an unavailable runtime becomes a
// hard failure naming the reason. A dev box still skips: requiring the
// deps everywhere would make the whole suite unrunnable for anyone on a
// platform SRT does not support or a container without user namespaces,
// and an unrunnable suite gets ignored rather than fixed.

import { probeSandbox } from '../../src/exec/index.js'

/** Same truthiness rule as the logger's CI check — `0`/`false`/empty are off. */
function required(): boolean {
  const v = process.env['VX_REQUIRE_SANDBOX']
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * Resolve whether the OS sandbox can run here.
 *
 * Returns `false` to skip on a host without the deps. THROWS when
 * `VX_REQUIRE_SANDBOX` is set and the runtime is unavailable — at module
 * scope that fails the whole test file with the reason attached, which
 * is the point: the suite cannot vanish quietly on the one machine whose
 * result gates a merge.
 */
export async function sandboxAvailable(label: string): Promise<boolean> {
  // macOS CI runners: the sandbox PROBES healthy but violation REPORTING is
  // lossy-by-OS under load (~5% of denials arrive with no unified-log
  // record — measured; the settle window halves the fail-exit case and the
  // residual is DROPPED, not delayed). The 2026-08-24 "non-enforcement"
  // reading was CORRECTED the same day: the signal was ambiguous and every
  // discriminating probe classified it as reporting loss with enforcement
  // intact; the enforcement canary is 220/220 across 11 CI runs and GATES
  // the darwin job as of 2026-08-25. These suites stay class-gated on
  // darwin CI because many of their pins assert on the violation LINES —
  // the lossy channel itself — so they would flake at the OS's loss rate.
  // A per-test skip is whack-a-mole; VX_REQUIRE_SANDBOX stays the explicit
  // opt-in. Coverage: enforcement on darwin CI via the canary; the full
  // suites on linux CI (bwrap, REQUIRE=1) and on darwin locally. Un-gate
  // if the pins are ever rewritten to assert on artifacts, not lines.
  if (!required() && process.platform === 'darwin' && process.env['CI'] !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${label}] skipping on darwin CI — sandbox-exec enforcement is unreliable under load on these runners (see the decision log)`,
    )
    return false
  }

  const availability = await probeSandbox()
  if (availability.available) return true

  if (required()) {
    throw new Error(
      `${label}: the OS sandbox is unavailable — ${availability.reason}. ` +
        `VX_REQUIRE_SANDBOX is set, so this is a failure and not a skip: these tests ` +
        `cover the isolation boundary and must not silently disappear. Install ` +
        `bubblewrap + socat + strace (and allow unprivileged user namespaces), or ` +
        `unset VX_REQUIRE_SANDBOX to skip them.`,
    )
  }

  // eslint-disable-next-line no-console
  console.warn(`[${label}] skipping — the OS sandbox is unavailable: ${availability.reason}`)
  return false
}
