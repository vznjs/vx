// An Nx output that resolves outside the workspace (an old generator's
// `reportsDirectory: "../../coverage/libs/util"`, read from the workspace
// root as Nx 23 reads it) was written as `workspaceFiles: ['../../…']`, and
// vx refused to load the config. It is dropped with a TODO.

import { describe, expect, it } from 'bun:test'
import { mapNxOutputs } from '../src/nx/nx-outputs.js'

describe('an output outside the workspace', () => {
  it('is dropped with a TODO, not written as a path core refuses', () => {
    const todos: string[] = []
    const out = mapNxOutputs(
      ['{options.reportsDirectory}', '../shared/out'],
      { reportsDirectory: '../../coverage/libs/util' },
      'libs/util',
      'util',
      todos,
    )
    expect(out).toEqual({ outFiles: [], wsOutFiles: [] })
    expect(todos).toEqual([
      'output "{options.reportsDirectory}" resolves to "../../coverage/libs/util", outside the workspace — vx caches only inside it; dropped',
      'output "../shared/out" resolves to "../shared/out", outside the workspace — vx caches only inside it; dropped',
    ])
  })

  // Control: the form Nx ≥ 19 writes stays a workspace output.
  it('a workspace path stays', () => {
    const todos: string[] = []
    expect(
      mapNxOutputs(
        ['{options.reportsDirectory}'],
        { reportsDirectory: '{workspaceRoot}/coverage/libs/util' },
        'libs/util',
        'util',
        todos,
      ),
    ).toEqual({ outFiles: [], wsOutFiles: ['coverage/libs/util'] })
    expect(todos).toEqual([])
  })
})
