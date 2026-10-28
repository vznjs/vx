// The binary side of github(): one verb per hook. The request is JSON on
// stdin, the answer JSON on stdout, warnings one per line on stderr. The
// env is the vx process's own: a plugin hook is not a task, so nothing
// filters it.
import { githubBranch } from '../src/cache-scope.js'
import { clampJobSummary, MAX_JOB_SUMMARY_BYTES, renderJobSummary } from '../src/summary.js'
import { appendFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const [verb, ...argv] = process.argv.slice(2)
const request = async (): Promise<any> => JSON.parse((await Bun.stdin.text()) || '{}')

// Bytecode (`--bytecode`) needs CommonJS, which has no top-level await.
async function main(): Promise<void> {
  switch (verb) {
    case 'config': {
      const { baseBranch } = await request()
      process.stdout.write(JSON.stringify(await githubBranch(process.env, baseBranch)))
      break
    }
    case 'summary': {
      const { summary, title, file } = await request()
      const used = await stat(file).then(
        (s) => s.size,
        () => 0,
      )
      const lead = used > 0 ? '\n' : ''
      const page = clampJobSummary(
        renderJobSummary(summary, title),
        MAX_JOB_SUMMARY_BYTES - used - lead.length,
      )
      if (page === '') process.stderr.write(`vx-ci: ${file} has no room for vx's page\n`)
      else await appendFile(file, lead + page, 'utf8')
      break
    }
    case 'setup': {
      const { runSetup } = await import('../src/setup.js')
      process.exitCode = await runSetup(
        'github',
        argv,
        path.join(homedir(), '.cache', 'vx', 'setup-debs'),
      )
      break
    }
    default:
      process.stderr.write(`vx-ci: unknown verb ${verb}\n`)
      process.exitCode = 2
  }
}

void main()
