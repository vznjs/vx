// Launching a compiled vx the way a user meets it, shared by check-binary.ts
// (the host binary, every `vx run ci`) and release.ts (the binaries a
// release ships). Bun 1.4.0's `--compile` signature is rejected by macOS
// ("code or signature have been modified": SIGKILL on launch, every build
// flavour, cross-compiled or native, measured 2026-09-02 on Darwin 27) until
// re-signed ad hoc. Bun 1.4.2's output is already ad-hoc signed and
// launches, so the re-sign happens only where macOS refused: `codesign`
// inside the sandbox is a `system-fsctl` violation no grant can lift
// (macOS 27, 2026-10-03).

export interface Launch {
  readonly exitCode: number
  readonly version: string
  readonly stderr: string
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b)

const spawn = (cmd: string[]) => Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })

/** `codesign -s - --force` then `--verify`; the failing step's output, or undefined. */
function resign(bin: string): string | undefined {
  for (const cmd of [
    ['codesign', '-s', '-', '--force', bin],
    ['codesign', '--verify', '--verbose=2', bin],
  ]) {
    const r = spawn(cmd)
    if (r.exitCode !== 0) {
      return `${cmd.join(' ')} failed (exit ${r.exitCode}):\n${text(r.stdout)}${text(r.stderr)}`
    }
  }
  return undefined
}

/** `<bin> --version`, re-signed and launched again if macOS refused it. */
export function launchVersion(bin: string): Launch {
  let r = spawn([bin, '--version'])
  if (r.exitCode !== 0 && process.platform === 'darwin') {
    const failed = resign(bin)
    if (failed !== undefined) return { exitCode: 1, version: '', stderr: failed }
    r = spawn([bin, '--version'])
  }
  return { exitCode: r.exitCode, version: text(r.stdout).trim(), stderr: text(r.stderr) }
}
