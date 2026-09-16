import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { execWord } from '../exec/index.js'

/**
 * The frame line for a shell verdict the task's own output leaves a mystery.
 * `sh -c 'exec <word> …'` exits 127 ("not found") and 126 ("cannot
 * execute"), and its one line names the word and nothing about why: a bare
 * word is a PATH lookup, and the PATH is vx's (item 257); a word with a
 * slash is a file, and "not found" for a file that exists is its `#!`
 * interpreter missing — the shell's text blames the file (item 258).
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
  if (args.code === 126) {
    return `[vx] exit 126 is the shell's "found but cannot execute": ${what} is not executable or is a directory — chmod +x it`
  }
  if (word === undefined || !word.includes('/')) {
    return `[vx] exit 127 is the shell's "command not found": ${what} is not on this task's PATH — vx puts ${args.bins.join(' and ')} first and never a sibling project's bin; install it in this package or at the workspace root`
  }
  const file = path.resolve(args.cwd, word)
  if (!existsSync(file)) {
    return `[vx] exit 127 is the shell's "not found": ${word} does not exist — looked for ${file}, relative to the task's working directory`
  }
  return `[vx] exit 127 is the shell's "not found", and ${word} exists: ${interpreterVerdict(file)}`
}

/** Why the shell could not run a file that is there: its `#!` line. */
function interpreterVerdict(file: string): string {
  let head: string
  try {
    if (statSync(file).isDirectory()) return 'it is a directory'
    head = readFileSync(file, 'latin1').slice(0, 256)
  } catch (err) {
    return `it could not be read (${(err as Error).message})`
  }
  if (!head.startsWith('#!')) {
    return 'it has no #! line, so the shell ran it as a binary the loader refused — add a #! line or build it for this platform'
  }
  const nl = head.indexOf('\n')
  const line = head.slice(2, nl === -1 ? head.length : nl)
  if (line.endsWith('\r')) {
    return `its #! line ends in CRLF, so the interpreter the shell looked for is "${line.trim()}\\r" — convert the file to LF line endings`
  }
  const interp = line.trim().split(/\s+/)[0] ?? ''
  return `its #! interpreter ${interp} does not exist — install it or fix the line`
}
