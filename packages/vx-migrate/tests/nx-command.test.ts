import { describe, expect, it } from 'bun:test'
import { nxRunCommand } from '../src/nx-command.js'

describe('nxRunCommand — where Nx ran it, with its placeholders expanded', () => {
  it('runs from the workspace root by default: a cd from the project dir, {projectRoot} expanded', () => {
    // storybook's `compile`, 2026-09-11.
    const todos: string[] = []
    expect(
      nxRunCommand(
        'node ./scripts/build/build-package.ts --cwd {projectRoot}',
        {
          projectRel: 'code/lib/cli',
          projectName: 'cli',
        },
        todos,
      ),
    ).toBe('cd ../../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli')
    expect(todos).toEqual([])
  })

  it('expands {projectName} and {workspaceRoot}', () => {
    expect(
      nxRunCommand(
        'yarn task build --template={projectName} --root {workspaceRoot}',
        {
          projectRel: 'sandbox/react-vite',
          projectName: 'react-vite',
        },
        [],
      ),
    ).toBe('cd ../.. && yarn task build --template=react-vite --root .')
  })

  it('stays in the project dir when cwd is {projectRoot} or the project path', () => {
    for (const cwd of ['{projectRoot}', 'packages/a', 'packages/a/']) {
      expect(
        nxRunCommand('yarn vitest', { projectRel: 'packages/a', projectName: 'a', cwd }, []),
      ).toBe('yarn vitest')
    }
  })

  it('cds to another declared cwd, relative to the project dir', () => {
    expect(
      nxRunCommand(
        'make',
        { projectRel: 'packages/pkg-b', projectName: 'pkg-b', cwd: 'packages/pkg-b/sub' },
        [],
      ),
    ).toBe('cd sub && make')
    expect(
      nxRunCommand(
        'make',
        { projectRel: 'packages/pkg-b', projectName: 'pkg-b', cwd: '{workspaceRoot}' },
        [],
      ),
    ).toBe('cd ../.. && make')
  })

  it('the workspace-root project runs there without a cd', () => {
    expect(nxRunCommand('echo root ci', { projectRel: '.', projectName: 'root' }, [])).toBe(
      'echo root ci',
    )
  })

  it('names {args.*} as unsupported', () => {
    const todos: string[] = []
    nxRunCommand(
      'vite build --mode {args.mode}',
      { projectRel: 'a', projectName: 'a', cwd: '{projectRoot}' },
      todos,
    )
    expect(todos).toHaveLength(1)
    expect(todos[0]).toContain('{args.*}')
  })
})
