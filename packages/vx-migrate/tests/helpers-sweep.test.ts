// Item 809's sweep of the shared helpers (script-command, persistent-note,
// shared-outputs, nx-dotenv): each row fails with one line of src/ undone.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { pruneOrphanPersistentNotes, type GeneratedTask } from '@vzn/vx'
import { scriptCommand } from '../src/script-command.js'
import { resolveSharedOutputs } from '../src/shared-outputs.js'
import { dotenvCandidates, listDotenv, ownerTargetOf } from '../src/nx/nx-dotenv.js'

describe('scriptCommand: the package manager’s own lifecycle hooks never ride a task', () => {
  it.each(['pack', 'publish', 'version'])('`pre%s` / `post%s` stay out of the task', (name) => {
    const scripts = { [`pre${name}`]: 'echo pre', [`post${name}`]: 'echo post' }
    expect(scriptCommand(name, 'echo body', scripts)).toBe('echo body')
  })

  it('CONTROL: an ordinary task’s hooks are folded around it', () => {
    expect(scriptCommand('build', 'tsc', { prebuild: 'gen', postbuild: 'copy' })).toBe(
      'vx_script() {\n(gen\n) && (tsc "$@"\n) && (copy\n)\n}\nvx_script',
    )
  })
})

describe('pruneOrphanPersistentNotes', () => {
  const NOTE = 'add readyWhen'
  const mapping = (deps: unknown[]) => [
    {
      tasks: [
        { name: 'dev', todos: ['keep me', NOTE, 'and me'], task: {} },
        { name: 'e2e', todos: [], task: { dependsOn: deps } },
      ],
    },
  ]

  it.each([
    ['a bare name', 'dev'],
    ['a ^ edge', '^dev'],
    ['a pkg# edge', 'web#dev'],
  ])('a task named through %s keeps its note', (_how, dep) => {
    const m = mapping([dep])
    pruneOrphanPersistentNotes(m, NOTE)
    expect(m[0]!.tasks[0]!.todos).toEqual(['keep me', NOTE, 'and me'])
  })

  it('an orphan loses the note alone, and a non-string dependsOn entry is passed over', () => {
    const m = mapping([42, { task: 'dev' }])
    pruneOrphanPersistentNotes(m, NOTE)
    expect(m[0]!.tasks[0]!.todos).toEqual(['keep me', 'and me'])
  })
})

describe('resolveSharedOutputs: an edge keeps no pair cached (core default rules, X-53)', () => {
  function task(name: string, outputs: string[], dependsOn: string[] = []): GeneratedTask {
    return {
      name,
      todos: [],
      task: {
        exec: { command: name },
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        cache: { inputs: { files: ['**/*'] }, outputs: { files: outputs } },
      },
    }
  }
  const cached = (ts: GeneratedTask[]) => ts.map((t) => t.task!['cache'] !== undefined)

  it('the keeper depending on the other task does not keep both', () => {
    expect(
      cached(
        resolveSharedOutputs([
          task('gen', ['dist/**']),
          task('build', ['dist/**'], ['^build', 'gen']),
        ]),
      ),
    ).toEqual([false, true])
  })

  it('a dependant of the keeper is uncached, and names the keeper', () => {
    const ts = resolveSharedOutputs([
      task('a', ['dist/**']),
      task('b', ['dist/**'], ['a']),
      task('c', ['dist/**'], ['a']),
    ])
    expect(cached(ts)).toEqual([true, false, false])
    expect(ts[2]!.todos[0]).toContain('"a" also declares')
  })

  it('a task is checked against every kept task, not just the first keeper', () => {
    // b keeps (no overlap with a), c overlaps b alone.
    const ts = resolveSharedOutputs([
      task('a', ['dist/**'], ['^build']),
      task('b', ['lib/**']),
      task('c', ['lib/x'], ['b']),
    ])
    expect(cached(ts)).toEqual([true, true, false])
    expect(ts[2]!.todos[0]).toContain('"b" also declares')
  })

  it('a same-project edge is not a ^ edge: the first declared keeps', () => {
    const ts = resolveSharedOutputs([
      task('a', ['out/**']),
      task('b', ['out/**'], ['lint']),
      { name: 'lint', todos: [], task: { exec: { command: 'lint' } } },
    ])
    expect(cached(ts)).toEqual([true, false, false])
  })

  it('a `!` output overlaps nothing: only positives say where outputs land', () => {
    const next = task('build', ['.next/**', '!.next/cache/**'])
    expect(cached(resolveSharedOutputs([next, task('export', ['out'])]))).toEqual([true, true])
  })
})

describe('nx dotenv', () => {
  it('an empty nonAtomizedTarget is no parent', () => {
    const targets = { 'e2e-ci--a': { metadata: { nonAtomizedTarget: '' } } }
    expect(ownerTargetOf('e2e-ci--a', targets, { g: ['e2e-ci--a'] })).toEqual([
      'e2e-ci--a',
      undefined,
    ])
  })

  it('`.<id>.env` names are listed beside `.env*` ones', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-dotenv-'))
    try {
      for (const f of ['.env', '.build.env', '.build.local.env', 'notes.env', '.gitignore']) {
        await writeFile(path.join(root, f), '')
      }
      const listing = await listDotenv(root, [])
      expect([...listing.get('.')!].sort()).toEqual(['.build.env', '.build.local.env', '.env'])
      expect(dotenvCandidates('.', 'build', undefined, undefined)).toContain('.build.env')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
