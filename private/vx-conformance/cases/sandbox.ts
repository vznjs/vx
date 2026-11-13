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
    why: 'A variable that reaches the command but not its key can change the output while the key stays the same. A later run with another value then replays the wrong result. Keeping undeclared variables out of the task makes that mistake fail loudly now instead of silently later.',
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
    why: 'Isolation exists to catch what a task did not declare, not to break tasks that declared everything. A task that reads only its inputs and writes only its outputs must run as it would without isolation. A sandbox that fails it makes isolation too costly to turn on.',
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
    why: 'A file the task reads but never declared is outside its key. An edit to that file would leave the key the same, and a later run would replay a stale result. Failing the read now shows the missing input at once, while it is cheap to add, instead of after a wrong replay.',
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
    why: 'Some files a task must read are not inputs, such as a tool’s config outside the project, and the user grants them on purpose. A granted read is a decision the user made, not a mistake to catch. Failing it forces users to turn isolation off for tasks that are already correct.',
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
    why: 'Reading another project’s source ties this task to files outside its key and its own folder. An edit there changes the output while nothing reruns. Failing the read makes the hidden link visible, so the user can declare the dependency instead of shipping a stale build.',
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
    why: 'A file written outside the outputs is never stored with the task. A later replay restores the outputs but not that file, so the tree differs depending on whether the task ran. Failing the write, and leaving nothing behind, keeps a run and a replay producing the same tree.',
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
    why: 'Writing into another project changes files that project owns and keys on, behind its back. Its next run may replay or rerun on content no one edited. Failing the write and leaving that project as it was keeps each project’s files under its own control and key.',
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
    why: 'A task that rewrites its own source changes its inputs while it runs, so its key no longer matches what it built from. A replay then hides the rewrite, or the next run loops on it. Failing the write and keeping the source protects the user’s code from a build step.',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: one(iso('mkdir -p dist && echo x > dist/out.txt && echo changed > src/a.txt')),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { 'packages/a/src/a.txt': 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/swallowed-source-write-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that hides its refused write still fails',
    why: 'A script that ignores a failed write exits 0 with the write undone. If the run passes, the task is cached as if it did everything it tried, and nothing tells the user the sandbox stopped part of it. The refusal itself must fail the task, whatever the script does with the error.',
    from: ['sandbox-grants.unsafe', 'compiled-sandbox.unsafe'],
    needs: ['sandbox'],
    workspace: one(
      iso(
        'mkdir -p dist && echo x > dist/out.txt && { echo changed > src/a.txt; } 2>/dev/null; true',
      ),
    ),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { 'packages/a/src/a.txt': 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/credential-store-hidden',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task cannot read the user’s SSH key',
    why: 'An SSH key in the user’s home is a secret no build should read. A task that can reach it can leak it through a log, an output or a cached artifact shared with others. An isolated task must see none of the home it did not declare, so a compromised script cannot take the key.',
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
    why: 'A response from the network is an input no key holds. The next run replays the saved result whatever the server says now, and two machines can build different bytes under one key. A task without a network grant must fail to connect, so that hidden input shows up at once.',
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
    why: 'A link inside the inputs can point at a file the task was never granted. Following it reads that file as surely as opening it directly, and the key does not cover it. Isolation must check where the link leads, or one symlink turns every grant into a way around it.',
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
