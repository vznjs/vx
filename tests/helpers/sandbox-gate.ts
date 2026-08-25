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
/**
 * Whether violation REPORTING can be relied on here.
 *
 * Enforcement and reporting are different properties with different
 * reliability, and conflating them cost real coverage. macOS feeds SRT's
 * violation store asynchronously from the unified log, which DROPS records
 * under load (~5% measured, structural — the settle window halves it and the
 * residual is gone, not late). So a pin asserting a violation LINE exists
 * flakes at the OS's loss rate on a loaded runner, while a pin asserting the
 * task FAILED or that the secret never reached the artifact does not — the
 * enforcement canary has been 340/340 across 17 CI runs on exactly that
 * distinction.
 *
 * Use this ONLY for tests whose product is the report itself (the
 * `undeclared-inputs` verdict, a line naming the file). Everything else
 * should assert on the artifact and run everywhere the sandbox exists.
 */
export async function sandboxReportingReliable(label: string): Promise<boolean> {
  if (!(await sandboxAvailable(label))) return false
  if (process.platform === 'darwin' && process.env['CI'] !== undefined && !required()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[${label}] skipping the REPORTING assertions on darwin CI — the unified log drops violation records under load; enforcement is still covered here and by the canary`,
    )
    return false
  }
  return true
}

export async function sandboxAvailable(label: string): Promise<boolean> {
  // macOS CI runners: the sandbox PROBES healthy but violation REPORTING is
  // lossy-by-OS under load (~5% of denials arrive with no unified-log
  // record — measured; the settle window halves the fail-exit case and the
  // residual is DROPPED, not delayed). The 2026-08-24 "non-enforcement"
  // reading was CORRECTED the same day: the signal was ambiguous and every
  // discriminating probe classified it as reporting loss with enforcement
  // intact; the enforcement canary is 340/340 across 17 CI runs and GATES
  // the darwin job.
  //
  // These suites were class-gated OFF darwin CI wholesale until
  // 2026-08-25, when the un-gate condition recorded with that decision was
  // met: their enforcement pins assert on ARTIFACTS (the task failed, the
  // secret never reached out.txt, the escape file does not exist), which
  // reporting loss cannot move. Only the pins whose PRODUCT is the report
  // — a verdict, a line naming a file — are still withheld there, by
  // `sandboxReportingReliable` above.
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
