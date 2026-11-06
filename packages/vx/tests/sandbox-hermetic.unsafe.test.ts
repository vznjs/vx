// `sandbox.hermetic`: the read wall moves from the workspace root to `/`.
// Without it a sandboxed task reads any path outside the workspace (the
// system toolchain, `~/.cache`) and folds none of it into its key (item
// 966), so a build can depend on the machine and nobody knows. A hermetic
// task reads outside the workspace only what `allow.read` names, plus the
// shell it runs in.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox hermetic test')

describe.skipIf(!available)(
  'a hermetic sandbox reads outside the workspace only what it names',
  () => {
    let fixture: Fixture
    let outside = ''

    beforeEach(async () => {
      fixture = await makeWorkspace()
      outside = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-hermetic-out-')))
      await writeFile(path.join(outside, 'tool.txt'), 'HOSTTOOL\n')
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    })

    const peek = async (sandbox: string): Promise<string[]> => {
      const file = path.join(outside, 'tool.txt')
      await addProject(fixture.root, 'app', {
        files: { 'src/x.txt': 'OWN\n' },
        config: `
        export default {
          tasks: {
            peek: {
              exec: {
                command: ${JSON.stringify(
                  // Builtins only: a hermetic task reads no binary it did not name.
                  `read l < src/x.txt; echo "$l"; read t 2>/dev/null < ${file} && echo "$t" || echo NOTOOL; { [ -e /etc/passwd ] || [ -e /usr/bin/xargs ]; } && echo USR || echo NOUSR`,
                )},
                sandbox: ${sandbox},
              },
            },
          },
        }
      `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['peek'], log: collectingLogger(fixture) })
      if (!r.ok) throw new Error(`run failed:\n${fixture.log.join('\n')}`)
      // The runtime's own socket sat under the host temp directory the deny hid.
      expect(fixture.log.join('\n')).not.toContain('observe_init_error')
      return fixture.log
        .flatMap((l) => l.split('\n'))
        .map((l) => l.trim())
        .filter((l) => /^(OWN|HOSTTOOL|NOTOOL|USR|NOUSR)$/.test(l))
    }

    it(
      'CONTROL: without it, a path outside the workspace is readable',
      async () => {
        expect(await peek(`{ allow: { read: ['.'] } }`)).toEqual(['OWN', 'HOSTTOOL', 'USR'])
      },
      TIMEOUT,
    )

    it(
      'with it, nothing outside the workspace is, and the task still runs',
      async () => {
        expect(await peek(`{ hermetic: true, allow: { read: ['.'] } }`)).toEqual([
          'OWN',
          'NOTOOL',
          'NOUSR',
        ])
      },
      TIMEOUT,
    )

    it(
      'with it, a path allow.read names is readable',
      async () => {
        expect(await peek(`{ hermetic: true, allow: { read: ['.', '${outside}'] } }`)).toEqual([
          'OWN',
          'HOSTTOOL',
          'NOUSR',
        ])
      },
      TIMEOUT,
    )

    it(
      "with it and a domain, the task still reaches the runtime's proxy",
      async () => {
        // The proxy's socket and the wait for its bridge (grep, sleep) are
        // the runtime's, outside the workspace.
        await addProject(fixture.root, 'app', {
          files: {},
          config: `
            export default {
              tasks: {
                net: {
                  exec: {
                    command: "grep -qsE ':0C38 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6 && echo PROXY || echo NOPROXY",
                    sandbox: { hermetic: true, allow: { read: ['.'], network: ['example.com'] } },
                  },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['net'], log: collectingLogger(fixture) })
        if (!r.ok) throw new Error(`run failed:\n${fixture.log.join('\n')}`)
        const out = fixture.log.join('\n')
        expect(out).toContain('PROXY')
        expect(out).not.toContain('NOPROXY')
        expect(out).not.toContain('not found')
      },
      TIMEOUT,
    )
  },
)
