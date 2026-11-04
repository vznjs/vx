// Isolation: what a task can reach beyond what it declares. A read nothing
// declared is a file outside the task's key, so an edit to it replays a
// stale result; a write nothing declared is a file the cache never
// restores; a variable nothing declared changes the output under the same
// key. A tool that isolates the task fails it instead, so the gap is found
// before it is cached.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { one, out } from './shapes.ts'

const iso = (command: string, sandbox: TaskSpec['sandbox'] = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  sandbox,
})

const SERVER = `exec bun -e 'Bun.serve({ hostname: "127.0.0.1", port: 47811, fetch: () => new Response("pong") }); console.log("listening")'`
const CLIENT = 'mkdir -p dist && curl -sf http://127.0.0.1:47811 > dist/out.txt'

export default [
  defineCase({
    id: 'sandbox/undeclared-env-hidden',
    category: 'sandbox',
    kind: 'correctness',
    title: 'A variable the task does not declare never reaches it',
    why: 'A variable that reaches the command but not its key changes the output under the same key: a later run replays the wrong result.',
    from: ['env', 'sandbox-parent-env.unsafe', 'parity-turbo-hashing-env'],
    workspace: one({
      command: 'mkdir -p dist && printf %s "${API_SECRET-unset}" > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      {
        run: 'build',
        env: { API_SECRET: 'leaked' },
        expect: { exit: 0, files: { [out('a')]: 'unset' } },
      },
    ],
  }),

  defineCase({
    id: 'sandbox/declared-reads-and-writes-pass',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that reads its inputs and writes its outputs succeeds',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && cat src/a.txt > dist/out.txt')),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/undeclared-read-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that reads a project file it never declared fails',
    why: 'The file is outside the key: an edit to it would replay a stale result.',
    from: ['sandbox-grants.unsafe', 'sandbox-hidden-reads.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && cat src/a.txt config.txt > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'config.txt': 'c\n',
    }),
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'sandbox/granted-read-passes',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task may read a file it is granted beyond its inputs',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: one(
      iso('mkdir -p dist && cat src/a.txt config.txt > dist/out.txt', { read: ['config.txt'] }),
      {
        'src/a.txt': 'a\n',
        'config.txt': 'c\n',
      },
    ),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nc\n' } } }],
  }),

  defineCase({
    id: 'sandbox/other-project-read-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that reads another project’s source fails',
    from: ['sandbox-grants.unsafe', 'nested-boundary'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && cat ../b/src/b.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'src/b.txt': 'b\n' } },
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'sandbox/undeclared-write-fails',
    category: 'sandbox',
    kind: 'correctness',
    title:
      'An isolated task that writes outside its outputs fails, and the file is not left behind',
    why: 'The cache never stores that file: a replay would leave the tree without it.',
    from: ['sandbox-grants.unsafe', 'sandbox-empty-outputs.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && echo x > dist/out.txt && echo stray > stray.txt')),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { 'packages/a/stray.txt': null } } }],
  }),

  defineCase({
    id: 'sandbox/other-project-write-fails',
    category: 'sandbox',
    kind: 'correctness',
    title:
      'An isolated task that writes into another project fails, and leaves that project as it was',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: iso('mkdir -p dist && echo x > dist/out.txt && echo hacked > ../b/src/b.txt'),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'src/b.txt': 'b\n' } },
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', files: { 'packages/b/src/b.txt': 'b\n' } } }],
  }),

  defineCase({
    id: 'sandbox/source-write-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that rewrites its own source fails, and the source is kept',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && echo x > dist/out.txt && echo changed > src/a.txt')),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { 'packages/a/src/a.txt': 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/credential-store-hidden',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task cannot read the user’s SSH key',
    from: ['sandbox-credential-stores.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && cat "$HOME/.ssh/id_ed25519" > dist/out.txt')),
    steps: [
      { write: { '.home/.ssh/id_ed25519': 'secret-key\n' } },
      { run: 'build', expect: { exit: 'fail', filesNot: { [out('a')]: 'secret-key\n' } } },
    ],
  }),

  defineCase({
    id: 'sandbox/network-refused',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task with no network grant cannot reach a server the run started',
    why: 'A response is an input no key holds: the next run replays it whatever the server says now.',
    from: ['sandbox-host-services.unsafe', 'sandbox-proxy-denials.unsafe'],
    needs: ['sandbox', 'persistent', 'ready'],
    workspace: {
      projects: {
        a: {
          tasks: {
            serve: { command: SERVER, persistent: { ready: 'listening' } },
            build: { ...iso(CLIENT), dependsOn: ['serve'] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 'fail', filesNot: { [out('a')]: 'pong' } } },
      // The same client, not isolated, reaches it: the server was up.
      {
        configure: (ws) => {
          const a = ws.projects['a']!
          const { sandbox: _, ...build } = a.tasks!['build']!
          return { ...ws, projects: { a: { ...a, tasks: { ...a.tasks, build } } } }
        },
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'pong' } } },
    ],
  }),

  defineCase({
    id: 'sandbox/link-out-of-grants-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task cannot read an undeclared file through a link inside its inputs',
    from: ['sandbox-grant-through-link.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && cat src/a.txt src/peek.txt > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'secret.txt': 's\n',
    }),
    steps: [
      { link: { 'packages/a/src/peek.txt': '../secret.txt' } },
      { run: 'build', expect: { exit: 'fail', filesNot: { [out('a')]: 'a\ns\n' } } },
    ],
  }),
]
