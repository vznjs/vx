import { parseArgs } from './parse.ts'
import { graphCommand } from './graph-cmd.ts'

const HELP = `vx — a monorepo task runner

Usage: vx <command> [args...]

Commands:
  graph              Print the workspace inventory (projects + targets) as JSON.
`

export interface CliOptions {
  cwd?: string
  write?: (chunk: string) => void
  writeErr?: (chunk: string) => void
}

export async function runCli(argv: readonly string[], opts: CliOptions = {}): Promise<number> {
  const write = opts.write ?? ((chunk: string) => process.stdout.write(chunk))
  const writeErr = opts.writeErr ?? ((chunk: string) => process.stderr.write(chunk))
  const cwd = opts.cwd ?? process.cwd()

  const parsed = parseArgs(argv)

  if (parsed.flags.help || parsed.command === 'help') {
    write(HELP)
    return 0
  }
  if (parsed.flags.version) {
    write('0.0.0\n')
    return 0
  }
  if (parsed.command === null) {
    write(HELP)
    return 0
  }

  switch (parsed.command) {
    case 'graph':
      return graphCommand({
        cwd,
        positional: parsed.positional,
        flags: parsed.flags,
        write,
        writeErr,
      })
    default:
      writeErr(`vx: unknown command "${parsed.command}"\n`)
      writeErr(HELP)
      return 1
  }
}
