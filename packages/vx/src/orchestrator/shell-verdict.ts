import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { execWord } from '../exec/index.js'

/**
 * The frame line for a shell verdict the task's own output leaves a mystery.
 * `sh -c 'exec <word> …'` exits 127 ("not found") and 126 ("cannot
 * execute"), and its one line names the word and nothing about why: a bare
 * word is a PATH lookup, and the PATH is vx's (item 257); a word with a
 * slash is a file, and the file itself says why — missing, a directory, no
 * execute bit, a `#!` interpreter that is not there (dash and bash 5 say
 * "not found" and blame the file; bash 3.2 names it itself and exits 1),
 * or no `#!` line at all (item 258).
 */
export function shellVerdict(args: {
  code: number
  command: string
  cwd: string
  bins: string[]
}): string | undefined {
  if (args.code !== 127 && args.code !== 126) return undefined
  const word = execWord(args.command)
  const what = word ?? 'a command in this task'
  if (word !== undefined && word.includes('/')) {
    const file = path.resolve(args.cwd, word)
    return `[vx] exit ${args.code} is the shell's "${args.code === 127 ? 'not found' : 'cannot execute'}": ${word} ${fileVerdict(file)}`
  }
  if (args.code === 126) {
    return `[vx] exit 126 is the shell's "found but cannot execute": ${what} is not executable or is a directory — chmod +x it`
  }
  return `[vx] exit 127 is the shell's "command not found": ${what} is not on this task's PATH — vx puts ${args.bins.join(' and ')} first and never a sibling project's bin; install it in this package or at the workspace root`
}

/** Why the shell could not run a file, read from the file. */
function fileVerdict(file: string): string {
  if (!existsSync(file)) {
    return `does not exist — looked for ${file}, relative to the task's working directory`
  }
  let head: string
  try {
    const st = statSync(file)
    if (st.isDirectory()) return 'is a directory'
    if ((st.mode & 0o111) === 0) return 'is not executable — chmod +x it'
    head = readFileSync(file, 'latin1').slice(0, 256)
  } catch (err) {
    return `could not be read (${(err as Error).message})`
  }
  if (!head.startsWith('#!')) {
    return 'has no #! line, so it ran as a binary the loader refused — add a #! line or build it for this platform'
  }
  const nl = head.indexOf('\n')
  const line = head.slice(2, nl === -1 ? head.length : nl)
  if (line.endsWith('\r')) {
    return `exists, and its #! line ends in CRLF, so the interpreter the shell looked for is "${line.trim()}\\r" — convert the file to LF line endings`
  }
  const interp = line.trim().split(/\s+/)[0] ?? ''
  if (interp.startsWith('/') && !existsSync(interp)) {
    return `exists, and its #! interpreter ${interp} does not — install it or fix the line`
  }
  return `exists and is executable, and the shell still could not run it — check its #! line (${line.trim()})`
}
