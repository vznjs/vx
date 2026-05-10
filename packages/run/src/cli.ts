import { VERSION } from './index.js'
import { run as runOrchestrator } from './orchestrator.js'

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      return 0
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`vzn ${VERSION}\n`)
      return 0
    case 'run':
      return await runCmd(rest)
    default:
      process.stderr.write(`vzn: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

async function runCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vzn run: ${parsed.error}\n`)
    return 1
  }
  if (!parsed.task) {
    process.stderr.write(`vzn run: missing task name\n`)
    return 1
  }
  const opts: Parameters<typeof runOrchestrator>[0] = {
    cwd: process.cwd(),
    task: parsed.task,
    force: parsed.force,
  }
  if (parsed.projects.length > 0) opts.projects = parsed.projects
  if (parsed.concurrency !== undefined) opts.concurrency = parsed.concurrency

  const summary = await runOrchestrator(opts)
  return summary.ok ? 0 : 1
}

interface RunArgs {
  task: string | undefined
  projects: string[]
  concurrency: number | undefined
  force: boolean
  error?: string
}

export function parseRunArgs(args: readonly string[]): RunArgs {
  const out: RunArgs = {
    task: undefined,
    projects: [],
    concurrency: undefined,
    force: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--project' || a === '-p') {
      const v = args[++i]
      if (!v) return { ...out, error: `${a} requires a value` }
      out.projects.push(v)
    } else if (a === '--concurrency' || a === '-c') {
      const v = args[++i]
      if (!v) return { ...out, error: `${a} requires a value` }
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1) return { ...out, error: `invalid concurrency: ${v}` }
      out.concurrency = Math.floor(n)
    } else if (a === '--force' || a === '-f') {
      out.force = true
    } else if (a && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}` }
    } else if (a !== undefined) {
      if (out.task !== undefined) {
        return { ...out, error: `unexpected positional: ${a}` }
      }
      out.task = a
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(
    [
      'vzn — open, extensible monorepo task runner',
      '',
      'Usage:',
      '  vzn run <task> [--project <name>]... [--concurrency <n>] [--force]',
      '  vzn help',
      '  vzn version',
      '',
      'Flags:',
      '  -p, --project <name>     Run only for the named project (repeatable).',
      '  -c, --concurrency <n>    Maximum concurrent tasks. Defaults to CPU count.',
      '  -f, --force              Ignore the cache and re-run every task.',
      '',
    ].join('\n'),
  )
}
