import { VERSION } from '@nxt/core'

export function run(argv: readonly string[]): number {
  const [command] = argv

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
      process.stdout.write(`nxt ${VERSION}\n`)
      return 0
    default:
      process.stderr.write(`nxt: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'nxt — open, extensible monorepo task runner',
      '',
      'Usage: nxt <command> [options]',
      '',
      'Commands:',
      '  help        Show this help',
      '  version     Print version',
      '',
      'Pre-alpha: more commands land as the engine is built.',
      '',
    ].join('\n'),
  )
}
