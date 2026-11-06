// Outcomes drawn from Nix's linux-sandbox.sh that the sandbox cases did not
// carry: a build closed off from the machine reads no file of it, still
// runs when it reads only what it declared, and writes nothing outside.
// The rest of that file tests Nix's store, `--check` and certificates.
// dependencies.sh adds the toolchain rule: an isolated build reads what
// its dependencies built, and nothing else of theirs.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

// Shell builtins only, writing beside the source (no mkdir): a closed task
// reads no program it did not grant, and a grant names a path per machine.
const TOOLS = {
  tools: {
    tasks: {
      build: {
        command: 'mkdir -p out && echo tool > out/tool.txt',
        inputs: ['src/**'],
        outputs: ['out/**'],
      },
    },
    files: { 'src/a.txt': 'source\n' },
  },
}

const reader = (command: string): TaskSpec => ({
  command,
  dependsOn: ['tools#build'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
  sandbox: {},
})

const closed = (command: string): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['out.txt'],
  sandbox: { hermetic: true },
})

export default [
  defineCase({
    id: 'sandbox/closed-machine-read-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'A task closed off from the machine cannot read a system file',
    why: 'A file of the machine, such as one under /etc, is an input no key holds and no other machine shares. A build that reads it can give different bytes on two machines under one key. A task closed off from the machine must fail that read, so the build depends only on what it declared.',
    from: ['sandbox-hermetic.unsafe'],
    needs: ['sandbox'],
    workspace: one(closed('read l < /etc/os-release && echo "$l" > out.txt')),
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'sandbox/closed-declared-reads-pass',
    category: 'sandbox',
    kind: 'correctness',
    title: 'A task closed off from the machine still runs when it reads only its inputs',
    why: 'Closing off the machine must not stop the shell and its tools from starting. A task that reads only its inputs and writes only its outputs needs nothing more. A closed sandbox that fails it cannot be turned on for real builds.',
    from: ['sandbox-hermetic.unsafe'],
    needs: ['sandbox'],
    workspace: one(closed('read l < src/a.txt && echo "$l" > out.txt')),
    steps: [{ run: 'build', expect: { exit: 0, files: { 'packages/a/out.txt': 'a\n' } } }],
  }),

  defineCase({
    id: 'sandbox/home-write-fails',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that writes into the home folder fails, and leaves nothing there',
    why: 'A file a build drops in the home folder is never stored with the task, and the next build may read it. Runs then depend on what earlier runs left behind. Failing the write, and leaving nothing, keeps every build starting from the same machine.',
    from: ['sandbox-grants.unsafe'],
    needs: ['sandbox'],
    workspace: one({
      command: 'mkdir -p dist && echo x > dist/out.txt && echo stray > "$HOME/stray.txt"',
      inputs: ['src/**'],
      outputs: ['dist/**'],
      sandbox: {},
    }),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { '.home/stray.txt': null } } }],
  }),

  defineCase({
    id: 'sandbox/dependency-output-readable',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task reads what the task it depends on built in another project',
    why: 'A dependency’s outputs are what the task asked for by depending on it, and its key moves with them. Hiding them makes one project unable to build a tool that others run. An isolated task must read them, or isolation cannot be used for builds with a toolchain step.',
    from: ['sandbox-dependency-outputs.unsafe'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        ...TOOLS,
        app: {
          tasks: { build: reader('mkdir -p dist && cat ../tools/out/tool.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'tool\n' } },
      },
    ],
  }),

  defineCase({
    id: 'sandbox/dependency-source-hidden',
    category: 'sandbox',
    kind: 'correctness',
    title: 'An isolated task that depends on another project still cannot read its sources',
    why: 'Depending on a task gives its outputs, not the files it was built from. A read of the dependency’s sources ties the build to files the edge never promised. Failing it keeps the edge meaning one thing: what the dependency built.',
    from: ['sandbox-dependency-outputs.unsafe'],
    needs: ['sandbox'],
    workspace: {
      projects: {
        ...TOOLS,
        app: {
          tasks: { build: reader('mkdir -p dist && cat ../tools/src/a.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [{ run: 'build', projects: ['app'], expect: { exit: 'fail' } }],
  }),
]
