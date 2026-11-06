// Outcomes drawn from Nix's linux-sandbox.sh that the sandbox cases did not
// carry: a build closed off from the machine reads no file of it, still
// runs when it reads only what it declared, and writes nothing outside.
// The rest of that file tests Nix's store, `--check` and certificates.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

// Shell builtins only, writing beside the source (no mkdir): a closed task
// reads no program it did not grant, and a grant names a path per machine.
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
]
