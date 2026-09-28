// The Conventional Commits rule this repo holds its PR titles and commit
// subjects to (CLAUDE.md § Workflow): `type(scope)!: summary`, scope and `!`
// optional, the type one of TYPES. Release notes and the version bump read
// these subjects (release-notes.ts), so one that does not parse is a change
// the notes miss. tests/conventional-commits.unsafe.test.ts applies it in CI.

const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'test',
  'docs',
  'ci',
  'build',
  'chore',
  'revert',
] as const

const SHAPE = /^(\w+)(?:\([\w./@-]+(?:,[\w./@-]+)*\))?!?: \S/

/** Why `line` is not a Conventional Commits header, or null when it is one. */
export function conventionalError(line: string): string | null {
  const m = SHAPE.exec(line)
  if (m === null) return 'not `type(scope): summary`'
  if (!(TYPES as readonly string[]).includes(m[1]!)) {
    return `unknown type '${m[1]}' (one of ${TYPES.join(', ')})`
  }
  return null
}
