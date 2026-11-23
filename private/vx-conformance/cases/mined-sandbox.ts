// Isolation outcomes mined from vx's own sandbox tests and its sandbox
// module page, from Nix's tests/functional (linux-sandbox.sh,
// dependencies.sh, check.sh) and from rivals' issues about tasks that
// write outside their outputs. Each case asks what an isolated task may
// reach (files, links, devices, temp, network, processes) and what a run
// keeps of a task its isolation refused.
import { defineCase, type Case, type Step, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { one, out } from './shapes.ts'

type Sandbox = TaskSpec['sandbox']

const iso = (command: string, sandbox: Sandbox = {}, more: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  sandbox,
  ...more,
})

/** Closed off from the machine: shell builtins only, writing `out.txt` beside the source. */
const closed = (command: string, more: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['out.txt'],
  sandbox: { hermetic: true },
  ...more,
})

const isoOne = (
  command: string,
  sandbox: Sandbox = {},
  files: Record<string, string> = {},
  more: Partial<TaskSpec> = {},
): WorkspaceSpec => one(iso(command, sandbox, more), { 'src/a.txt': 'a\n', ...files })

const passes = (files: Record<string, string | null> = {}): Step[] => [
  { run: 'build', expect: { exit: 0, files } },
]
const fails = (files: Record<string, string | null> = {}): Step[] => [
  { run: 'build', expect: { exit: 'fail', files } },
]

type Draft = Omit<Case, 'category' | 'kind' | 'needs'> & Partial<Pick<Case, 'kind' | 'needs'>>
const sandboxCase = (c: Draft): Case =>
  defineCase({ category: 'sandbox', kind: 'correctness', needs: ['sandbox'], ...c })

const A = 'packages/a'
const T = '${TMPDIR:-/tmp}'
const serve = (port: number) =>
  `exec bun -e 'Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("pong") }); console.log("listening")'`
const fetch = (port: number) => `mkdir -p dist && curl -sf http://127.0.0.1:${port} > dist/out.txt`

/** `lib` builds `dist/out.txt` (not isolated); `app` depends on it and runs `command` isolated. */
const consumer = (command: string, appSandbox: Sandbox = {}): WorkspaceSpec => ({
  projects: {
    lib: {
      tasks: {
        build: {
          command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
          inputs: ['src/**'],
          outputs: ['dist/**'],
        },
      },
      files: { 'src/a.txt': 'lib\n' },
    },
    app: {
      deps: ['lib'],
      tasks: { build: iso(command, appSandbox, { dependsOn: ['^build'] }) },
      files: { 'src/a.txt': 'app\n' },
    },
  },
})

/** Project `a` with a plain `gen` task writing `gen/g.txt` and an isolated `build`. */
const withGen = (build: TaskSpec): WorkspaceSpec => ({
  projects: {
    a: {
      tasks: {
        gen: {
          command: 'mkdir -p gen && echo g > gen/g.txt',
          inputs: ['src/**'],
          outputs: ['gen/**'],
        },
        build,
      },
      files: { 'src/a.txt': 'a\n' },
    },
  },
})

const reads: Case[] = [
  sandboxCase({
    id: 'sandbox/granted-dir-nested-file-readable',
    title: 'An isolated task granted a directory may read a file deep inside it',
    why: 'A directory grant stands for everything under it, the way a directory input does. A tool that reads a nested config, such as a preset in a subfolder, must find it. A grant that only covered the top level would force users to list every file and break as soon as one is added.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat config/deep/x.txt > dist/out.txt',
      { read: ['config'] },
      {
        'config/deep/x.txt': 'x\n',
      },
    ),
    steps: passes({ [out('a')]: 'x\n' }),
  }),

  sandboxCase({
    id: 'sandbox/granted-file-sibling-hidden',
    title: 'An isolated task granted one file cannot read the file next to it',
    why: 'A grant naming a file opens that file and nothing else. The file beside it is outside the key and outside what the user allowed. Widening a file grant to its folder would make every grant name more than it says, and a stale replay would follow the first edit to the neighbour.',
    from: ['sandbox-grants.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && cat config/a.txt config/b.txt > dist/out.txt',
      { read: ['config/a.txt'] },
      { 'config/a.txt': 'ca\n', 'config/b.txt': 'cb\n' },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/input-glob-other-extension-hidden',
    title: 'An isolated task whose inputs are `src/*.txt` cannot read `src/a.md`',
    why: 'An input glob names the files that key the task, not the folder they sit in. A Markdown file next to the text inputs is outside the key, so an edit to it would replay a stale result. Isolation has to follow the glob, not the folder, or narrow inputs give no protection.',
    from: ['sandbox-grants.unsafe', 'sandbox-hidden-reads.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/a.txt src/a.md > dist/out.txt',
      {},
      { 'src/a.md': 'md\n' },
      { inputs: ['src/*.txt'] },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/listing-project-hides-undeclared-names',
    title: 'An isolated task that lists its project folder does not see an undeclared file’s name',
    why: 'A file’s name is data too: a tool that globs the project and acts on what it finds builds from files it never declared. If the listing shows an undeclared file, adding or removing it changes the output under the same key. Either the listing leaves it out or the task fails; it must never end up in the output.',
    from: ['sandbox-widened-reads.unsafe', 'sandbox-grant-ancestors.unsafe'],
    workspace: isoOne('mkdir -p dist && ls -a > dist/out.txt', {}, { 'secret-notes.txt': 's\n' }),
    steps: [{ run: 'build', expect: { filesNot: { [out('a')]: 'secret-notes' } } }],
  }),

  sandboxCase({
    id: 'sandbox/granted-workspace-root-file-readable',
    title: 'An isolated task may read a workspace root file it is granted',
    why: 'Shared configs, such as a base tsconfig, live at the workspace root and every project reads them. The user grants that file on purpose. A sandbox that cannot reach up out of the project for a granted file forces each project to copy it.',
    from: ['sandbox-grants.unsafe'],
    workspace: {
      ...isoOne('mkdir -p dist && cat ../../tsconfig.base.json > dist/out.txt', {
        read: ['../../tsconfig.base.json'],
      }),
      files: { 'tsconfig.base.json': '{}\n' },
    },
    steps: passes({ [out('a')]: '{}\n' }),
  }),

  // linux-sandbox.sh: the build sees its declared inputs and not the rest of the machine.
  sandboxCase({
    id: 'sandbox/closed-outside-checkout-read-fails',
    title: 'A task closed off from the machine cannot read a file beside the checkout',
    why: 'A file next to the repository, such as a sibling checkout, is on this machine only. A closed task that read it would build differently on a machine without it, under the same key. Closing a task off from the machine means anything outside the workspace is out of reach unless granted.',
    from: ['sandbox-hermetic.unsafe'],
    workspace: {
      ...one(closed('read l < ../../../outside/x.txt && echo "$l" > out.txt')),
      outside: { 'x.txt': 'x\n' },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', filesNot: { [`${A}/out.txt`]: 'x' } } }],
  }),

  sandboxCase({
    id: 'sandbox/closed-granted-outside-read-passes',
    title: 'A task closed off from the machine may read a file beside the checkout it is granted',
    why: 'Closing a task off is a default, not a ban: the user can still name a file outside the workspace the build needs. The grant says the read is on purpose. Failing it would leave no way to run such a build closed off at all.',
    from: ['sandbox-hermetic.unsafe'],
    workspace: {
      ...one(
        closed('read l < ../../../outside/x.txt && echo "$l" > out.txt', {
          sandbox: { hermetic: true, read: ['../../../outside/x.txt'] },
        }),
      ),
      outside: { 'x.txt': 'x\n' },
    },
    steps: passes({ [`${A}/out.txt`]: 'x\n' }),
  }),

  sandboxCase({
    id: 'sandbox/dev-null-writable',
    title: 'An isolated task may throw output away into /dev/null',
    why: 'Scripts send noise to /dev/null all the time, and nothing is stored there. Treating it as a write outside the outputs fails tasks that did nothing wrong. A sandbox must keep the usual devices working.',
    from: ['sandbox-trace-exit.unsafe'],
    workspace: isoOne('mkdir -p dist && echo noise > /dev/null && cat src/a.txt > dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/dev-urandom-readable',
    title: 'An isolated task may read random bytes from /dev/urandom',
    why: 'Temporary file names, test seeds and hashes all draw on /dev/urandom. It is not a file anyone edits, so reading it is no hidden input. A sandbox that hides it breaks ordinary tools for no gain.',
    from: ['sandbox-trace-exit.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && head -c 16 /dev/urandom | wc -c | tr -d " " > dist/out.txt',
    ),
    steps: passes({ [out('a')]: '16\n' }),
  }),

  sandboxCase({
    id: 'sandbox/closed-dev-null-writable',
    title: 'A task closed off from the machine may still write to /dev/null',
    why: 'Closing a task off from the machine’s files is about inputs, not devices. /dev/null holds nothing, so writing to it cannot change any later build. A closed sandbox that breaks it breaks almost every shell script.',
    from: ['sandbox-hermetic.unsafe'],
    workspace: one(closed('echo x > /dev/null && read l < src/a.txt && echo "$l" > out.txt')),
    steps: passes({ [`${A}/out.txt`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/closed-dev-urandom-readable',
    title: 'A task closed off from the machine may still open /dev/urandom',
    why: 'A runtime opens /dev/urandom as it starts, to seed its hashing. That is no input a key could hold, and no machine’s file a build should be kept from. A closed sandbox without it cannot run most programs.',
    from: ['sandbox-hermetic.unsafe'],
    workspace: one(closed('exec 3< /dev/urandom && echo ok > out.txt')),
    steps: passes({ [`${A}/out.txt`]: 'ok\n' }),
  }),

  sandboxCase({
    id: 'sandbox/dev-stderr-writable',
    title: 'What an isolated task writes to /dev/stderr goes to its error stream',
    why: 'Many scripts print errors with `> /dev/stderr` rather than `>&2`. That path goes through the process’s own descriptors, and a sandbox must keep it pointing at the task’s error stream. Losing it hides the very message that explains a failure.',
    from: ['sandbox-trace-exit.unsafe'],
    workspace: isoOne('mkdir -p dist && { echo said-hi > /dev/stderr; } 2> dist/out.txt'),
    steps: passes({ [out('a')]: 'said-hi\n' }),
  }),

  sandboxCase({
    id: 'sandbox/dev-stdout-writable',
    title: 'What an isolated task writes to /dev/stdout goes to its output stream',
    why: 'Tools that take an output path are often handed `/dev/stdout` to print instead of write a file. The device must lead to the task’s own output stream, wherever that points. A sandbox that hides it breaks the usual way to pipe such a tool.',
    from: ['sandbox-trace-exit.unsafe'],
    workspace: isoOne('mkdir -p dist && cp src/a.txt /dev/stdout > dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/machine-file-readable-when-not-closed',
    title: 'An isolated task that is not closed off from the machine may read a system file',
    why: 'Isolation guards the workspace: what a task reads there must be declared. Tools also read the machine’s own files, such as the user database or certificates, and only a task closed off from the machine is kept from those. Refusing them by default would break nearly every program.',
    from: ['sandbox-hermetic.unsafe', 'sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat /etc/passwd > /dev/null && cat src/a.txt > dist/out.txt',
    ),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/input-by-absolute-path-readable',
    title: 'An isolated task may read its input through an absolute path',
    why: 'Tools resolve every path to an absolute one before they open it. The file is the same declared input whichever way it is spelled. A sandbox must judge the file, not the spelling.',
    from: ['sandbox-paths', 'sandbox-grants.unsafe'],
    workspace: isoOne('mkdir -p dist && cat "$PWD/src/a.txt" > dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/granted-dir-listable',
    title: 'An isolated task may list the files of a folder it is granted',
    why: 'Tools find their files by listing a folder, then read each one. A granted folder’s names are part of what the user allowed. A sandbox that grants the files but hides the listing leaves the tool finding nothing.',
    from: ['sandbox-grant-ancestors.unsafe', 'sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && ls config > dist/out.txt',
      { read: ['config'] },
      { 'config/a.cfg': '1\n', 'config/b.cfg': '2\n' },
    ),
    steps: passes({ [out('a')]: 'a.cfg\nb.cfg\n' }),
  }),

  sandboxCase({
    id: 'sandbox/runner-environ-unreadable',
    title: 'An isolated task cannot read an undeclared variable from another process’s environment',
    why: 'Hiding a variable from the task is pointless if the task can read it from the runner through /proc. A secret there could end up in an output or a log shared with others, and its value changes the build under the same key. The task must see only its own processes.',
    from: ['sandbox-parent-env.unsafe', 'sandbox-helper-env.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && { cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" > dist/out.txt; true; }',
    ),
    steps: [
      {
        run: 'build',
        env: { API_SECRET: 'leaked-value' },
        expect: { filesNot: { [out('a')]: 'leaked-value' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/fallback-on-hidden-file-fails',
    title: 'An isolated task that falls back when an undeclared file seems missing still fails',
    why: 'The file exists on disk; only the sandbox hides it. Without isolation the task would read it, so the fallback output is not what the task really builds. Passing would cache that fallback, and the task would act differently the day isolation is turned off.',
    from: ['sandbox-hidden-reads.unsafe', 'sandbox-grant-through-link.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && { cat config.txt 2>/dev/null || echo default; } > dist/out.txt',
      {},
      { 'config.txt': 'real\n' },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/undeclared-dir-cd-fails',
    title: 'An isolated task that changes into an undeclared folder fails',
    why: 'A task that enters a folder is about to work there, reading or writing files it never declared. If the folder is hidden, the command cannot do what it would do outside. Failing makes the missing grant visible.',
    from: ['sandbox-chdir-denied.unsafe'],
    workspace: isoOne(
      'cd docs && cd .. && mkdir -p dist && cat src/a.txt > dist/out.txt',
      {},
      { 'docs/readme.txt': 'r\n' },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/swallowed-refused-cd-fails',
    title: 'An isolated task that ignores a refused change of folder still fails',
    why: 'Outside the sandbox the `cd` would work and the rest of the script would run in that folder, writing somewhere else. Inside, the refusal silently changes what the script does. A run that passes it caches a result the task would never produce without isolation.',
    from: ['sandbox-chdir-denied.unsafe'],
    workspace: isoOne(
      'cd docs 2>/dev/null; mkdir -p dist && cat src/a.txt > dist/out.txt',
      {},
      { 'docs/readme.txt': 'r\n' },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/undeclared-executable-run-fails',
    title: 'An isolated task that runs an undeclared script from its project fails',
    why: 'Running a script reads it, so the script is an input whether or not it was declared. An edit to the generator would change the output while the key stays the same. Isolation must treat running it like reading it.',
    from: ['sandbox-hidden-reads.unsafe', 'sandbox-observe.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && ./tools/gen.sh > dist/out.txt',
      {},
      {
        'tools/gen.sh': '#!/bin/sh\necho gen\n',
      },
    ),
    steps: [{ chmod: { [`${A}/tools/gen.sh`]: 0o755 } }, ...fails()],
  }),

  sandboxCase({
    id: 'sandbox/dependency-output-program-runs',
    title: 'An isolated task may run a program its dependency built',
    why: 'A toolchain project builds a code generator and others run it. The program is the dependency’s declared output, and its key moves with it. A sandbox that lets the task read the file but not run it breaks the whole pattern.',
    from: ['sandbox-dependency-outputs.unsafe'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command:
                'mkdir -p out && printf "#!/bin/sh\\necho generated\\n" > out/tool.sh && chmod +x out/tool.sh',
              inputs: ['src/**'],
              outputs: ['out/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: iso(
              'mkdir -p dist && ../lib/out/tool.sh > dist/out.txt',
              {},
              {
                dependsOn: ['^build'],
              },
            ),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'generated\n' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/recursive-grep-misses-undeclared',
    title: 'An isolated task that greps its whole project never reads an undeclared file',
    why: 'Recursive tools open every file they find, often through a directory handle rather than a path. An undeclared file read that way still becomes part of the output. The sandbox must hide it however it is opened, or fail the task.',
    from: ['sandbox-dirfd-open.unsafe', 'sandbox-widened-reads.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && { grep -rh token . > dist/out.txt 2>/dev/null; true; }',
      {},
      { 'src/a.txt': 'token-a\n', 'notes.txt': 'token-secret\n' },
    ),
    steps: [{ run: 'build', expect: { filesNot: { [out('a')]: 'token-secret' } } }],
  }),

  sandboxCase({
    id: 'sandbox/link-within-inputs-readable',
    title: 'An isolated task may read a link that points at another of its inputs',
    why: 'A link inside the inputs that stays inside them reads a declared file. Its bytes are keyed through the target. Refusing it would break every project that links a shared source inside its own folder.',
    from: ['sandbox-grant-through-link.unsafe', 'sandbox-link-out-of-project.unsafe'],
    workspace: isoOne('mkdir -p dist && cat src/alias.txt > dist/out.txt'),
    steps: [{ link: { [`${A}/src/alias.txt`]: 'a.txt' } }, ...passes({ [out('a')]: 'a\n' })],
  }),

  sandboxCase({
    id: 'sandbox/dotfile-in-input-dir-readable',
    title: 'An isolated task may read a dotfile inside its input folder',
    why: 'A glob like `src/**` covers hidden files too, such as `src/.babelrc`. The file keys the task, so reading it is declared. A sandbox that hides dotfiles breaks tools that keep their config next to the sources.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/.hidden > dist/out.txt',
      {},
      {
        'src/.hidden': 'h\n',
      },
    ),
    steps: passes({ [out('a')]: 'h\n' }),
  }),

  sandboxCase({
    id: 'sandbox/input-dir-with-quote-readable',
    title: 'An isolated task may read inputs in a folder whose name holds a quote',
    why: 'Folder names come from users, and a quote in one is legal on every disk. A sandbox that builds its rules as text can lose such a path and refuse a declared read. Declared inputs must be readable whatever their names hold.',
    from: ['sandbox-dirfd-quote.unsafe', 'sandbox-glob-chars.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && grep -rh . src > dist/out.txt',
      {},
      { 'src/a.txt': 'a\n', 'src/q"d/b.txt': 'b\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, filesNot: { [out('a')]: 'missing' } } },
      { sh: `grep -qx b ${out('a')} && grep -qx a ${out('a')}` },
    ],
  }),

  sandboxCase({
    id: 'sandbox/project-dir-with-brackets-isolated-passes',
    title: 'An isolated task runs in a project whose folder name holds brackets',
    why: 'A bracket in a path reads as a glob class to many tools. If the sandbox treats the project folder as a pattern, it grants nothing and the task cannot read its own sources. A literal folder name must stay literal.',
    from: ['sandbox-glob-chars.unsafe'],
    workspace: {
      projects: {
        legacy: {
          dir: 'packages/[legacy]',
          tasks: { build: iso('mkdir -p dist && cat src/a.txt > dist/out.txt') },
          files: { 'src/a.txt': 'l\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/[legacy]/dist/out.txt': 'l\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/granted-file-with-space-readable',
    title: 'An isolated task may read a granted file whose name has a space',
    why: 'A grant is a path, and paths may hold spaces. A sandbox that splits the grant on whitespace grants two wrong names and refuses the real one. The task then fails for a read the user allowed.',
    from: ['sandbox-grants.unsafe', 'sandbox-hint-spelling.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat "my config.txt" > dist/out.txt',
      { read: ['my config.txt'] },
      {
        'my config.txt': 'c\n',
      },
    ),
    steps: passes({ [out('a')]: 'c\n' }),
  }),

  sandboxCase({
    id: 'sandbox/brace-grant-reads-each',
    title: 'An isolated task granted `{a,b}.cfg` may read both files',
    why: 'Braces are how a glob names a short list, and users write grants the way they write inputs. Kept as one literal name, the grant opens no file at all. Each alternative must be granted.',
    from: ['sandbox-grants.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && cat a.cfg b.cfg > dist/out.txt',
      { read: ['{a,b}.cfg'] },
      {
        'a.cfg': '1\n',
        'b.cfg': '2\n',
      },
    ),
    steps: passes({ [out('a')]: '1\n2\n' }),
  }),

  sandboxCase({
    id: 'sandbox/glob-grant-other-file-hidden',
    title: 'An isolated task granted `*.cfg` cannot read a `.txt` file beside them',
    why: 'A glob grant names the files it matches. The text file in the same folder is neither an input nor granted. Opening the whole folder for a glob would let every file there in under the same key.',
    from: ['sandbox-grants.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && cat a.cfg notes.txt > dist/out.txt',
      { read: ['*.cfg'] },
      {
        'a.cfg': '1\n',
        'notes.txt': 'n\n',
      },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/glob-grant-skips-link-out-of-project',
    title: 'A glob grant in a project does not reach another project through a link it matches',
    why: 'A link named `shared` that points into another project matches `*`, but following it reads files the user never meant to grant. Those files key nothing here, so an edit there replays a stale result. A glob reaches no further through a link than a folder grant would.',
    from: ['sandbox-grant-through-link.unsafe', 'sandbox-request'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: iso('mkdir -p dist && cat shared/b.txt > dist/out.txt', { read: ['*'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'src/b.txt': 'b\n' } },
      },
    },
    steps: [
      { link: { [`${A}/shared`]: '../b/src' } },
      { run: 'build', expect: { exit: 'fail', filesNot: { [out('a')]: 'b' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/root-project-read-all-skips-nested-projects',
    title: 'The root package’s task granted its whole folder still cannot read a nested project',
    why: 'The root package’s folder holds every other project. Its own key stops where a nested project starts, so a grant of `.` there must stop too. Otherwise a root task reads a member’s files outside its key and replays them stale.',
    from: ['sandbox-request', 'nested-boundary'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tasks: {
            build: {
              command: 'mkdir -p out && cat packages/a/src/a.txt > out/r.txt',
              inputs: ['tools/**'],
              outputs: ['out/**'],
              sandbox: { read: ['.'] },
            },
          },
          files: { 'tools/t.txt': 't\n' },
        },
        a: { files: { 'src/a.txt': 'a\n' } },
      },
    },
    steps: [{ run: 'build', projects: ['root'], expect: { exit: 'fail' } }],
  }),

  sandboxCase({
    id: 'sandbox/grant-is-per-task',
    title: 'A read granted to one task does not reach another task of the same project',
    why: 'Grants belong to a task, not to its project. A `check` task that never asked for `config.txt` is not keyed on it. If one task’s grant leaked to the other, the second would read an unkeyed file and replay stale results.',
    from: ['sandbox-grants.unsafe', 'sandbox-network-per-task.unsafe'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: iso('mkdir -p dist && cat config.txt > dist/out.txt', {
              read: ['config.txt'],
            }),
            check: iso(
              'mkdir -p chk && cat config.txt > /dev/null && echo ok > chk/out.txt',
              {},
              { outputs: ['chk/**'] },
            ),
          },
          files: { 'src/a.txt': 'a\n', 'config.txt': 'c\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'c\n' } } },
      { run: 'check', expect: { exit: 'fail', files: { [`${A}/chk/out.txt`]: null } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/new-input-file-readable-next-run',
    title: 'A file added to an isolated task’s inputs is readable on the next run',
    why: 'An input glob matches files that exist when the run starts, and a new source joins the key at once. If the sandbox kept the files it saw first, the new file would be refused though declared. Each run must grant what the glob matches now.',
    from: ['sandbox-grants.unsafe', 'inputs-moved-sandbox.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/*.txt > dist/out.txt',
      {},
      {},
      {
        inputs: ['src/*.txt'],
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nb\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/root-input-readable',
    title: 'An isolated task may read a workspace root file its inputs name',
    why: 'A root input keys the task, so the task declared it and its edits rerun it. Refusing the read means a task cannot be both keyed on a shared root config and isolated. Every input a task declares is a file it may read.',
    from: ['sandbox-grants.unsafe', 'sandbox-fix'],
    workspace: {
      ...isoOne(
        'mkdir -p dist && cat ../../base.json > dist/out.txt',
        {},
        {},
        {
          rootInputs: ['base.json'],
        },
      ),
      files: { 'base.json': '{}\n' },
    },
    steps: passes({ [out('a')]: '{}\n' }),
  }),
]

const deps: Case[] = [
  sandboxCase({
    id: 'sandbox/transitive-dependency-output-readable',
    title: 'An isolated task may read the outputs of its dependency’s dependency',
    why: 'Builds read through a chain: an app bundles a ui library that wraps a core one, and the bundler opens all three. The far dependency’s outputs fold into the key through the near one. Hiding them breaks every bundle.',
    from: ['sandbox-dependency-outputs.unsafe'],
    workspace: {
      projects: {
        core: {
          tasks: { build: iso('mkdir -p dist && cat src/a.txt > dist/out.txt') },
          files: { 'src/a.txt': 'core\n' },
        },
        ui: {
          deps: ['core'],
          tasks: {
            build: iso(
              'mkdir -p dist && cat src/a.txt > dist/out.txt',
              {},
              {
                dependsOn: ['^build'],
              },
            ),
          },
          files: { 'src/a.txt': 'ui\n' },
        },
        app: {
          deps: ['ui'],
          tasks: {
            build: iso(
              'mkdir -p dist && cat ../core/dist/out.txt > dist/out.txt',
              {},
              {
                dependsOn: ['^build'],
              },
            ),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'core\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/unordered-sibling-output-read-fails',
    title: 'An isolated task cannot read what a task of its project it does not depend on built',
    why: 'Without an edge, the other task may run before, after or beside this one, and its outputs key nothing here. Reading them gives a result that depends on timing and replays stale bytes. Declaring the dependency is how the task gets them.',
    from: ['sandbox-dependency-outputs.unsafe', 'sandbox-request'],
    workspace: withGen(iso('mkdir -p dist && cat gen/g.txt > dist/out.txt')),
    steps: [
      { run: 'gen', expect: { exit: 0, files: { [`${A}/gen/g.txt`]: 'g\n' } } },
      { run: 'build', expect: { exit: 'fail' } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/same-project-dependency-output-readable',
    title: 'An isolated task may read what a task of its own project it depends on built',
    why: 'A code generator and the compile that reads its output often live in one project. The edge makes the generated files part of the compile’s key. A sandbox that only grants other projects’ outputs breaks this common shape.',
    from: ['sandbox-dependency-outputs.unsafe'],
    workspace: withGen(
      iso('mkdir -p dist && cat gen/g.txt > dist/out.txt', {}, { dependsOn: ['gen'] }),
    ),
    steps: passes({ [out('a')]: 'g\n' }),
  }),

  sandboxCase({
    id: 'sandbox/replayed-dependency-output-readable',
    title: 'An isolated task reads its dependency’s outputs when the dependency was replayed',
    why: 'On a warm run the dependency is restored from the cache instead of run. Its outputs are the same files, so the dependant must see them the same way. A sandbox that only grants outputs a task wrote this run fails every partial rebuild.',
    from: ['sandbox-dependency-outputs.unsafe'],
    workspace: consumer('mkdir -p dist && cat ../lib/dist/out.txt src/a.txt > dist/out.txt'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'lib\napp\n' } } },
      { write: { 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { 'packages/app/dist/out.txt': 'lib\napp2\n' },
        },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/swallowed-dependency-output-touch-passes',
    title:
      'An isolated task whose ignored touch of a dependency’s output is refused still passes, and the output is unchanged',
    why: '`tsc -b` touches an up-to-date dependency’s build info and ignores a refusal. Nothing reached the disk: the file and its time are as they were. Failing the task for it would fail every build after a branch switch until the cache is cleared.',
    from: ['sandbox-dependency-outputs.unsafe'],
    workspace: consumer(
      'mkdir -p dist && cat ../lib/dist/out.txt > dist/out.txt && { touch ../lib/dist/out.txt; } 2>/dev/null; true',
    ),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/app/dist/out.txt': 'lib\n', 'packages/lib/dist/out.txt': 'lib\n' },
        },
      },
    ],
  }),

  // dependencies.sh: an isolated build reaches its dependencies’ outputs, closed off or not.
  sandboxCase({
    id: 'sandbox/closed-dependency-output-readable',
    title: 'A task closed off from the machine may still read its dependency’s outputs',
    why: 'Closing a task off hides the machine, not the workspace graph. A dependency’s outputs are inside the workspace and keyed through the edge. A closed task that cannot read them cannot take part in a build chain at all.',
    from: ['sandbox-hermetic.unsafe', 'sandbox-dependency-outputs.unsafe'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: closed('read l < ../lib/dist/out.txt && echo "$l" > out.txt', {
              dependsOn: ['^build'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [{ run: 'build', expect: { exit: 0, files: { 'packages/app/out.txt': 'lib\n' } } }],
  }),
]

const writes: Case[] = [
  sandboxCase({
    id: 'sandbox/hardlink-made-by-task-to-undeclared-fails',
    title: 'An isolated task cannot read an undeclared file by hard-linking it into its outputs',
    why: 'A hard link is the same file under a new name, so linking an undeclared file into the outputs reads it without opening it. Its edits would change the output under the same key. The sandbox must stop the link, not just the open.',
    from: ['sandbox-widened-reads.unsafe', 'sandbox-hidden-reads.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && ln secret.txt dist/peek.txt && cat dist/peek.txt > dist/out.txt',
      {},
      { 'secret.txt': 'secret\n' },
    ),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          files: { [`${A}/dist/peek.txt`]: null },
          filesNot: { [out('a')]: 'secret' },
        },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/hardlink-into-file-output-fails',
    title: 'An isolated task that hard-links an undeclared file over its output file fails',
    why: 'With an output file at the project root, the task can write beside it, and `ln -f notes.txt out.txt` copies an undeclared file into the output without reading it. The cached output then holds bytes no key covers. That link must fail the task.',
    from: ['sandbox-widened-reads.unsafe'],
    workspace: isoOne(
      'ln -f notes.txt out.txt',
      {},
      { 'notes.txt': 'n\n' },
      { outputs: ['out.txt'] },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/file-output-sibling-read-fails',
    title:
      'An isolated task with an output file at its project root cannot read the files beside it',
    why: 'To let a task replace `out.txt` by renaming, a sandbox may have to open the whole folder for writing. That must not open it for reading too. A sibling read is still an undeclared input, and its edits would replay stale results.',
    from: ['sandbox-widened-reads.unsafe'],
    workspace: isoOne(
      'cat src/a.txt notes.txt > out.txt',
      {},
      { 'notes.txt': 'n\n' },
      { outputs: ['out.txt'] },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/file-output-sibling-write-fails',
    title:
      'An isolated task with an output file at its project root that writes another file there fails',
    why: 'The task declared one file at the root, not the folder. A second file written there is not stored with the task, so a replay leaves it out. However the sandbox grants the output, a write beside it is undeclared.',
    from: ['sandbox-widened-reads.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: isoOne(
      'cat src/a.txt > out.txt && echo x > other.txt',
      {},
      {},
      {
        outputs: ['out.txt'],
      },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/file-output-sibling-remove-fails',
    title:
      'An isolated task with an output file at its project root that deletes a file beside it fails',
    why: 'Deleting a file the task does not own changes the project behind the user’s back, and the next run starts from a different tree. A replay would not delete it, so a run and a replay differ. The removal is an undeclared write.',
    from: ['sandbox-widened-reads.unsafe'],
    workspace: isoOne(
      'cat src/a.txt > out.txt && rm notes.txt',
      {},
      { 'notes.txt': 'n\n' },
      { outputs: ['out.txt'] },
    ),
    steps: fails(),
  }),

  sandboxCase({
    id: 'sandbox/readlink-undeclared-link-fails',
    title: 'An isolated task that reads where an undeclared link points fails',
    why: 'A link’s target is its content as far as git and a key are concerned. A task that writes `readlink cfg` into its output builds from that target. When the link moves, the output changes, so reading it undeclared must fail.',
    from: ['sandbox-widened-reads.unsafe'],
    workspace: isoOne('readlink cfg > out.txt', {}, {}, { outputs: ['out.txt'] }),
    steps: [{ link: { [`${A}/cfg`]: 'v1' } }, ...fails()],
  }),

  sandboxCase({
    id: 'sandbox/atomic-rename-onto-file-output-passes',
    title: 'An isolated task may write its output file by renaming a temporary file over it',
    why: 'Compilers and most careful writers stage the output beside it and rename it into place. That is a write of the declared output and nothing else that lasts. A sandbox that refuses the rename makes every such tool fail on a declared output.',
    from: ['sandbox-grants.unsafe', 'sandbox-output-link.unsafe'],
    workspace: isoOne(
      'cat src/a.txt > .out.tmp && mv .out.tmp out.txt',
      {},
      {},
      {
        outputs: ['out.txt'],
      },
    ),
    steps: passes({ [`${A}/out.txt`]: 'a\n', [`${A}/.out.tmp`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/rename-output-out-of-outputs-fails',
    title: 'An isolated task that moves its output out of its output folder fails',
    why: 'A file moved out of the outputs ends up where nothing stores it. A replay restores the outputs, which now lack it, and never recreates the moved file. The move is an undeclared write, so it must fail and leave nothing outside.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && mv dist/out.txt moved.txt'),
    steps: fails({ [`${A}/moved.txt`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/input-delete-fails',
    title: 'An isolated task that deletes one of its inputs fails, and the input is kept',
    why: 'A build step that deletes a source changes its own inputs, so the next run builds from a different tree. A replay would not delete it, so a run and a replay disagree. The sandbox must refuse the delete and keep the file.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && rm src/a.txt'),
    steps: fails({ [`${A}/src/a.txt`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/undeclared-file-delete-fails',
    title: 'An isolated task that deletes an undeclared project file fails, and the file is kept',
    why: 'Cleanup scripts sometimes delete more than they should. A file the task never declared belongs to the user or to another task. Refusing the delete protects it, and failing shows the script reaches too far.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && echo x > dist/out.txt && rm notes.txt',
      {},
      {
        'notes.txt': 'n\n',
      },
    ),
    steps: fails({ [`${A}/notes.txt`]: 'n\n' }),
  }),

  sandboxCase({
    id: 'sandbox/input-chmod-fails',
    title: 'An isolated task that changes an input’s permissions fails, and the mode is kept',
    why: 'A mode change is a write: git records the executable bit and a key can hold it. A task that flips it changes its own inputs behind the user’s back. The sandbox must refuse it like any other write to a source.',
    from: ['sandbox-grants.unsafe', 'sandbox-open-flags'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && chmod 755 src/a.txt'),
    steps: [...fails(), { check: { modes: { [`${A}/src/a.txt`]: 0o644 } } }],
  }),

  sandboxCase({
    id: 'sandbox/swallowed-input-touch-keeps-time',
    title: 'An isolated task that touches an input leaves the input’s time as it was',
    why: 'Tools that touch sources to force a rebuild change file times that watchers and other tools read. A sandbox keeps the sources read-only, times included. Whatever the task makes of the refusal, the source on disk must be untouched.',
    from: ['sandbox-dependency-outputs.unsafe', 'sandbox-open-flags'],
    workspace: isoOne(
      'mkdir -p dist && cat src/a.txt > dist/out.txt && { touch src/a.txt; } 2>/dev/null; true',
    ),
    steps: [
      { sh: `touch -d @946684800 ${A}/src/a.txt` },
      { run: 'build', expect: { files: { [`${A}/src/a.txt`]: 'a\n' } } },
      { sh: `test "$(stat -c %Y ${A}/src/a.txt)" = 946684800` },
    ],
  }),

  sandboxCase({
    id: 'sandbox/new-file-in-inputs-fails',
    title:
      'An isolated task that writes a new file into its input folder fails, and nothing is left',
    why: 'A file the task drops among its sources joins the input glob on the next run. The key moves for a change nobody made, and a replay never writes the file. The sandbox must refuse it and leave the folder as it was.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && echo x > src/new.txt'),
    steps: fails({ [`${A}/src/new.txt`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/sibling-task-output-write-fails',
    title: 'An isolated task that writes into another task’s output folder in its project fails',
    why: 'That folder is what the other task stores and restores. A file dropped there by this task is saved with the wrong task, or wiped when the other task replays. Each task writes only what it declares.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: {
      projects: {
        a: {
          ...withGen(iso('mkdir -p dist gen && echo x > dist/out.txt && echo x > gen/x.txt'))
            .projects['a'],
          files: { 'src/a.txt': 'a\n', 'gen/.keep': '' },
        },
      },
    },
    steps: [
      { run: 'build', only: true, expect: { exit: 'fail', files: { [`${A}/gen/x.txt`]: null } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/empty-dir-outside-outputs-fails',
    title:
      'An isolated task that makes an empty folder outside its outputs fails, and the folder is not left',
    why: 'An empty folder is still a change to the tree, and tools test for folders. A replay never makes it, so a run and a replay leave different trees. Making it is an undeclared write.',
    from: ['sandbox-mkdir-ancestor.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: isoOne('mkdir -p dist junk && echo x > dist/out.txt'),
    steps: [{ run: 'build', expect: { exit: 'fail' } }, { check: { missing: [`${A}/junk`] } }],
  }),

  sandboxCase({
    id: 'sandbox/symlink-outside-outputs-fails',
    title: 'An isolated task that makes a link outside its outputs fails, and the link is not left',
    why: 'A link is a file to git and to every tool that walks the tree. Made outside the outputs, it is never stored, so a replay leaves it out. Creating it is an undeclared write like any other.',
    from: ['sandbox-grants.unsafe', 'sandbox-output-link.unsafe'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && ln -s src/a.txt alias.txt'),
    steps: [{ run: 'build', expect: { exit: 'fail' } }, { check: { missing: [`${A}/alias.txt`] } }],
  }),

  sandboxCase({
    id: 'sandbox/output-dir-linked-out-refused',
    title:
      'An isolated task whose output folder is a link into another project cannot write through it',
    why: 'A link left in the place of `dist`, by a checkout or an earlier run, points the task’s writes into another project. Following it lets one project rewrite another’s files under a green run. The output must stay in the project, so the write fails and the other project is untouched.',
    from: ['sandbox-output-link.unsafe', 'sandbox-write-through-link.unsafe'],
    workspace: {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && echo x > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'out/.keep': '' } },
      },
    },
    steps: [
      { link: { [`${A}/dist`]: '../b/out' } },
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 'fail', files: { 'packages/b/out/out.txt': null } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/link-made-then-written-through-fails',
    title:
      'An isolated task cannot write into another project through a link it makes in its outputs',
    why: 'A link inside the outputs can point anywhere. Writing through it lands in the target, which here is another project’s source. The sandbox must judge a write by where it lands, so the write fails and the source is kept.',
    from: ['sandbox-write-through-link.unsafe', 'sandbox-link-out-of-project.unsafe'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: iso('mkdir -p dist && ln -s ../../b/src dist/l && echo hacked > dist/l/b.txt'),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: { files: { 'src/b.txt': 'b\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 'fail', files: { 'packages/b/src/b.txt': 'b\n' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/output-via-dotdot-passes',
    title: 'An isolated task may write its output through a path that climbs out of a subfolder',
    why: 'Scripts often `cd` into the sources and write `../dist/out.txt`. The file lands in the declared outputs, which is all that matters. A sandbox that judged the path as written rather than where it points would refuse a legal write.',
    from: ['sandbox-chdir-denied.unsafe', 'sandbox-paths'],
    workspace: isoOne('mkdir -p dist && cd src && cat a.txt > ../dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/workspace-root-write-fails',
    title:
      'An isolated task that writes a file at the workspace root fails, and nothing is left there',
    why: 'Lint caches and logs at the root are shared by every project and stored by none. A file a task drops there changes what the next task, in any project, may read. The write is undeclared and must fail.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: isoOne('mkdir -p dist && echo x > dist/out.txt && echo x > ../../.eslintcache'),
    steps: fails({ '.eslintcache': null }),
  }),

  sandboxCase({
    id: 'sandbox/granted-workspace-root-write-passes',
    title: 'An isolated task may write into a workspace root folder it is granted',
    why: 'Some tools keep a shared cache at the workspace root, and the user grants it on purpose. The grant says the write is expected. A sandbox that cannot grant a path above the project forces such tools to run without isolation.',
    from: ['sandbox-grants.unsafe'],
    workspace: {
      ...isoOne('mkdir -p dist && echo x > dist/out.txt && echo c > ../../.cache/tool/c', {
        write: ['../../.cache/tool/'],
      }),
      files: { '.cache/tool/.keep': '' },
    },
    steps: passes({ '.cache/tool/c': 'c\n' }),
  }),

  sandboxCase({
    id: 'sandbox/outside-checkout-write-fails',
    title: 'An isolated task that writes beside the checkout fails, and nothing is left there',
    why: 'A file written next to the repository is outside every project and every store. The next build, or another checkout, can read it. Isolation has to stop writes anywhere outside the declared paths, not only inside the workspace.',
    from: ['sandbox-misrooted-writes.unsafe', 'sandbox-outside-writes-hint'],
    workspace: {
      ...isoOne('mkdir -p dist && echo x > dist/out.txt && echo x > ../../../outside/w.txt'),
      outside: { 'keep.txt': '' },
    },
    steps: fails({ '../outside/w.txt': null }),
  }),

  sandboxCase({
    id: 'sandbox/node-modules-cache-write-fails',
    title: 'An isolated task that writes a cache into node_modules without a grant fails',
    why: 'Babel, ESLint and others keep caches in `node_modules/.cache`. That folder is not an output, so nothing restores it, and the next run reads what this one left. The write is undeclared unless the user grants it.',
    from: ['sandbox-node-modules-link.unsafe', 'sandbox-write-through-link.unsafe'],
    workspace: isoOne(
      'mkdir -p dist node_modules/.cache/tool && echo x > node_modules/.cache/tool/c && echo x > dist/out.txt',
    ),
    steps: fails({ [`${A}/node_modules/.cache/tool/c`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/mkdir-in-granted-write-dir-passes',
    title: 'An isolated task may make a folder inside a folder it is granted for writing',
    why: 'A grant of `node_modules/.cache/` lets a tool keep its cache there, and the tool makes its own subfolder with `mkdir -p`. That walks through folders that already exist before it makes the new one. A sandbox that counts the walk as a refused write fails a clean task.',
    from: ['sandbox-mkdir-ancestor.unsafe'],
    workspace: isoOne(
      'mkdir -p dist node_modules/.cache/tool && echo x > node_modules/.cache/tool/c && echo x > dist/out.txt',
      { write: ['node_modules/.cache/'] },
      { 'node_modules/.cache/.keep': '' },
    ),
    steps: passes({ [`${A}/node_modules/.cache/tool/c`]: 'x\n' }),
  }),

  sandboxCase({
    id: 'sandbox/mkdir-existing-input-dir-passes',
    title: 'An isolated task may run `mkdir -p` on its input folder that already exists',
    why: 'Build scripts make sure their folders exist before they start, sources included. `mkdir -p` on a folder that is there writes nothing. A sandbox that treats it as a write to the inputs fails a task that changed nothing.',
    from: ['sandbox-mkdir-ancestor.unsafe'],
    workspace: isoOne('mkdir -p src dist && cat src/a.txt > dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/write-grant-dir-made-by-task-passes',
    title: 'An isolated task may make and fill a granted folder that does not exist yet',
    why: 'A cache folder a tool creates on first use does not exist before the first run. The grant names it, so writes there are declared. A sandbox that can only grant folders that already exist fails the first run of every such tool.',
    from: ['sandbox-mkdir-ancestor.unsafe', 'sandbox-placeholder-nested.unsafe'],
    workspace: isoOne('mkdir -p dist gen && echo g > gen/g.txt && echo x > dist/out.txt', {
      write: ['gen/'],
    }),
    steps: passes({ [`${A}/gen/g.txt`]: 'g\n' }),
  }),

  sandboxCase({
    id: 'sandbox/deep-output-dir-made-by-task-passes',
    title: 'An isolated task may make a nested output folder that does not exist yet',
    why: 'Outputs like `build/lib/**` live several folders down, and the task makes them as it writes. The whole path leads to a declared output. Refusing the folders on the way fails every build with a nested output.',
    from: ['sandbox-mkdir-ancestor.unsafe'],
    workspace: isoOne(
      'mkdir -p build/lib && cat src/a.txt > build/lib/x.js',
      {},
      {},
      {
        outputs: ['build/lib/**'],
      },
    ),
    steps: passes({ [`${A}/build/lib/x.js`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/output-parent-not-writable',
    title: 'An isolated task with outputs in `build/lib` cannot write a file in `build`',
    why: 'The output is `build/lib`, not `build`. A file one level up is not stored with the task, so a replay leaves it out. Making the folders on the way to an output does not make them outputs.',
    from: ['sandbox-mkdir-ancestor.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: isoOne(
      'mkdir -p build/lib && cat src/a.txt > build/lib/x.js && echo x > build/other.txt',
      {},
      {},
      { outputs: ['build/lib/**'] },
    ),
    steps: fails({ [`${A}/build/other.txt`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/root-glob-output-passes',
    title: 'An isolated task may write an output its `*.js` pattern at the project root matches',
    why: 'Some builds write `index.js` beside `package.json`, and declare `*.js` as the output. The file it writes is exactly what the pattern names. A sandbox that cannot grant a pattern before any file matches it loses the output or fails the task.',
    from: ['sandbox-write-glob-new-file.unsafe', 'sandbox-empty-grant-spelling.unsafe'],
    workspace: isoOne('cat src/a.txt > index.js', {}, {}, { outputs: ['*.js'] }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/index.js`]: 'a\n' } } },
      { sh: `rm ${A}/index.js` },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/index.js`]: 'a\n' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/file-glob-output-in-new-dir-passes',
    title:
      'An isolated task may write an output its `dist/*.js` pattern matches in a folder it makes',
    why: '`dist/*.js` is a common output, and `dist` does not exist before the first build. The written file is what the pattern names. Refusing it because the folder had nothing to match when the task started breaks the first run.',
    from: ['sandbox-write-glob-new-file.unsafe', 'sandbox-empty-grant-spelling.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/a.txt > dist/a.js',
      {},
      {},
      {
        outputs: ['dist/*.js'],
      },
    ),
    steps: passes({ [`${A}/dist/a.js`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/deep-glob-output-passes',
    title:
      'An isolated task may write an output its `dist/**/*.js` pattern matches in a nested folder',
    why: 'A recursive pattern with an extension is how most builds name their JavaScript output. The file lies under `dist` and matches. A sandbox must grant what such a pattern can match, including folders the task makes.',
    from: ['sandbox-write-glob-new-file.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist/sub && cat src/a.txt > dist/sub/a.js',
      {},
      {},
      {
        outputs: ['dist/**/*.js'],
      },
    ),
    steps: passes({ [`${A}/dist/sub/a.js`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/write-glob-grant-new-file-passes',
    title: 'An isolated task granted `logs/*.log` may create a new log file there',
    why: 'A write grant by pattern is for files the task will make, not only ones that exist. The new file matches the pattern the user wrote. Refusing it makes a pattern grant useless for anything but rewriting old files.',
    from: ['sandbox-write-glob-new-file.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && echo x > dist/out.txt && cp src/a.txt logs/new.log',
      { write: ['logs/*.log'] },
      { 'logs/old.log': 'o\n' },
    ),
    steps: passes({ [`${A}/logs/new.log`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/output-dir-inside-inputs-writable',
    title:
      'An isolated task may write generated files into an output folder inside its input folder',
    why: 'Code generators often write `src/gen/` next to the sources the compile reads. The output folder is declared, even though the input glob around it is read-only. The sandbox must open the inner folder for writing and keep the rest read-only.',
    from: ['sandbox-grants.unsafe', 'sandbox-readonly-masks.unsafe'],
    workspace: isoOne(
      'mkdir -p src/gen && cat src/a.txt > src/gen/out.txt',
      {},
      {},
      {
        outputs: ['src/gen/**'],
      },
    ),
    steps: passes({ [`${A}/src/gen/out.txt`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/inputs-around-output-dir-read-only',
    title:
      'An isolated task with an output folder inside its inputs still cannot write the inputs around it',
    why: 'Opening `src/gen` for writing must not open all of `src`. A file written next to the sources joins the input glob and moves the key for a change nobody made. Only the declared output folder is writable.',
    from: ['sandbox-grants.unsafe', 'sandbox-readonly-masks.unsafe'],
    workspace: isoOne(
      'mkdir -p src/gen && cat src/a.txt > src/gen/out.txt && echo x > src/b.txt',
      {},
      {},
      { outputs: ['src/gen/**'] },
    ),
    steps: fails({ [`${A}/src/b.txt`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/write-inside-read-grant-passes',
    title: 'An isolated task may write a folder it is granted inside a folder it may only read',
    why: 'A tool reads its config folder and writes a generated part of it, so the user grants the folder to read and its `gen` subfolder to write. The narrower write grant must win inside it. Otherwise the user cannot express a common layout.',
    from: ['sandbox-readonly-masks.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && cat config/c.txt > dist/out.txt && echo g > config/gen/g.txt',
      { read: ['config'], write: ['config/gen/'] },
      { 'config/c.txt': 'c\n', 'config/gen/.keep': '' },
    ),
    steps: passes({ [out('a')]: 'c\n', [`${A}/config/gen/g.txt`]: 'g\n' }),
  }),

  sandboxCase({
    id: 'sandbox/read-grant-around-write-grant-read-only',
    title: 'An isolated task cannot write beside a write grant inside a folder it may only read',
    why: 'A write grant for `config/gen` opens that folder and nothing next to it. `config/x.txt` is under a read grant only. Letting the write grant spread to its parent would open files the user never meant to give.',
    from: ['sandbox-readonly-masks.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && echo x > dist/out.txt && echo x > config/x.txt',
      { read: ['config'], write: ['config/gen/'] },
      { 'config/c.txt': 'c\n', 'config/gen/.keep': '' },
    ),
    steps: fails({ [`${A}/config/x.txt`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/read-grant-not-writable',
    title: 'An isolated task granted a file to read cannot overwrite it',
    why: 'A read grant says the task needs the file’s bytes, not that it may change them. A task that rewrites its config changes a file the user owns. The write must fail and the file stay as it was.',
    from: ['sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat config.txt > dist/out.txt && echo changed > config.txt',
      { read: ['config.txt'] },
      { 'config.txt': 'c\n' },
    ),
    steps: fails({ [`${A}/config.txt`]: 'c\n' }),
  }),

  sandboxCase({
    id: 'sandbox/write-grant-readable',
    title: 'An isolated task may read back a file in a folder it is granted to write',
    why: 'A tool’s cache folder is read and written by the same tool. Granting a folder for writing has to let the task read what is there. A write-only grant breaks every tool that checks its cache before it fills it.',
    from: ['sandbox-grants.unsafe', 'sandbox-request'],
    workspace: isoOne(
      'mkdir -p dist && cat cache/old.txt > dist/out.txt',
      { write: ['cache/'] },
      { 'cache/old.txt': 'old\n' },
    ),
    steps: passes({ [out('a')]: 'old\n' }),
  }),

  sandboxCase({
    id: 'sandbox/touch-new-output-passes',
    title: 'An isolated task may create an empty output file with `touch`',
    why: '`touch` opens the file for writing and then sets its times, two steps a sandbox may judge apart. Both act on a declared output. A stamp file written that way is ordinary and must pass.',
    from: ['sandbox-open-flags', 'sandbox-observe.unsafe'],
    workspace: isoOne('mkdir -p dist && touch dist/out.txt'),
    steps: passes({ [out('a')]: '' }),
  }),

  sandboxCase({
    id: 'sandbox/own-previous-output-readable',
    title: 'An isolated task may read what its previous run left in its outputs',
    why: 'Incremental compilers read their own last output, such as a build info file, to skip work. The file is the task’s declared output, so reading it reads nothing undeclared. A sandbox that hides old outputs breaks every incremental tool.',
    from: ['sandbox-grants.unsafe', 'sandbox-dependency-outputs.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && { cat dist/out.txt 2>/dev/null || true; } > dist/prev.txt && cat src/a.txt > dist/out.txt',
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/fifo-made-and-removed-in-outputs-passes',
    title: 'An isolated task may make and remove a named pipe inside its outputs',
    why: 'Test runners and shells use named pipes to talk between processes. A pipe made and removed inside the outputs leaves nothing behind. The sandbox should not treat it as a forbidden kind of write.',
    from: ['sandbox-bridge-socket.unsafe', 'sandbox-observe.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && mkfifo dist/p && rm dist/p && cat src/a.txt > dist/out.txt',
    ),
    steps: passes({ [out('a')]: 'a\n', [`${A}/dist/p`]: null }),
  }),

  sandboxCase({
    id: 'sandbox/hardlink-within-outputs-passes',
    title: 'An isolated task may hard-link one of its outputs to another',
    why: 'Some tools save space by hard-linking identical outputs. Both names are declared outputs, and no outside file is reached. The sandbox has no reason to refuse it.',
    from: ['sandbox-widened-reads.unsafe'],
    workspace: isoOne('mkdir -p dist && cat src/a.txt > dist/a.txt && ln dist/a.txt dist/out.txt'),
    steps: passes({ [out('a')]: 'a\n', [`${A}/dist/a.txt`]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/clean-and-rebuild-output-dir-passes',
    title: 'An isolated task may delete its whole output folder and write it again',
    why: '`rm -rf dist && tsc` is how a great many builds start. The folder and everything in it are declared outputs, so removing and recreating them touches nothing else. A sandbox that cannot allow this forces users to rewrite their build scripts to turn it on.',
    from: ['sandbox-grant-remove.unsafe'],
    workspace: isoOne('rm -rf dist && mkdir dist && cat src/a.txt > dist/out.txt'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'b\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/clean-output-contents-passes',
    title: 'An isolated task may empty its output folder before it writes',
    why: 'Removing the old files inside the output folder, `rm -rf dist/*`, keeps a stale file from an earlier build out of the result. Everything removed is a declared output. The task must pass and leave only what it wrote.',
    from: ['sandbox-grant-remove.unsafe'],
    workspace: isoOne('mkdir -p dist && rm -rf dist/* && cat src/a.txt > dist/out.txt'),
    steps: [
      { write: { [`${A}/dist/stale.txt`]: 's\n' } },
      ...passes({ [out('a')]: 'a\n', [`${A}/dist/stale.txt`]: null }),
    ],
  }),

  sandboxCase({
    id: 'sandbox/git-hooks-write-fails',
    title: 'An isolated task that writes a git hook fails, and no hook is left',
    why: 'A hook in `.git/hooks` runs on the user’s next commit, outside any sandbox. A build script that plants one escapes isolation for good. The repository’s metadata is never a task’s to write.',
    from: ['sandbox-deny-scan.unsafe', 'sandbox-git-config.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && echo x > dist/out.txt && printf "#!/bin/sh\\ntrue\\n" > ../../.git/hooks/pre-commit',
    ),
    steps: fails({ '.git/hooks/pre-commit': null }),
  }),

  sandboxCase({
    id: 'sandbox/output-dir-linked-inside-project-passes',
    title:
      'An isolated task may write through an output folder that links to another folder of its project',
    why: 'Some projects keep `dist` as a link to a build folder of their own. The writes land inside the project, in a folder the task owns through the link. Only a link that leaves the project is a reason to refuse.',
    from: ['sandbox-output-link.unsafe', 'sandbox-placeholder-nested.unsafe'],
    workspace: isoOne('cat src/a.txt > dist/out.txt', {}, { 'build/.keep': '' }),
    steps: [{ link: { [`${A}/dist`]: 'build' } }, ...passes({ [`${A}/build/out.txt`]: 'a\n' })],
  }),
]

const temp: Case[] = [
  sandboxCase({
    id: 'sandbox/temp-dir-writable',
    title: 'An isolated task may write and read back a file in its temp folder',
    why: 'Compilers, archivers and test runners all need scratch space. The temp folder is where they look, and what goes there is gone after the task. A sandbox that refuses it breaks most tools.',
    from: ['sandbox-temp-vars.unsafe', 'sandbox-scratch-probe.unsafe'],
    workspace: isoOne(
      `cat src/a.txt > "${T}/conf-w.txt" && mkdir -p dist && cat "${T}/conf-w.txt" > dist/out.txt`,
    ),
    steps: passes({ [out('a')]: 'a\n' }),
  }),

  sandboxCase({
    id: 'sandbox/temp-not-shared-between-tasks',
    title: 'A file one isolated task leaves in its temp folder is not seen by the next task',
    why: 'A file passed through a shared temp folder is an input of the second task that no key holds. Change what the first one writes and the second replays its old output. Each isolated task needs a temp folder of its own.',
    from: ['sandbox-temp-vars.unsafe', 'sandbox-temp-hint.unsafe'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: iso(
              `echo leaked > "${T}/conf-shared.txt" && mkdir -p gen && echo g > gen/g.txt`,
              {},
              {
                outputs: ['gen/**'],
              },
            ),
            build: iso(
              `mkdir -p dist && { cat "${T}/conf-shared.txt" 2>/dev/null || echo missing; } > dist/out.txt`,
              {},
              { dependsOn: ['gen'] },
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: passes({ [out('a')]: 'missing\n' }),
  }),

  sandboxCase({
    id: 'sandbox/temp-not-kept-across-runs',
    title: 'A file an isolated task leaves in its temp folder is gone on its next run',
    why: 'A tool that keeps state in the temp folder makes its next run depend on its last one, outside any key. The output then depends on history, not on inputs. Starting every run with an empty temp folder keeps runs comparable.',
    from: ['sandbox-temp-vars.unsafe'],
    workspace: isoOne(
      `mkdir -p dist && { cat "${T}/conf-keep.txt" 2>/dev/null || echo missing; } > dist/out.txt && cat src/a.txt > "${T}/conf-keep.txt"`,
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'missing\n' } } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'missing\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/host-tmp-var-writable',
    title: 'An isolated task may write where a passed-through `TMP` tells it to',
    why: 'Windows-minded tools read `TMP` or `TEMP` rather than `TMPDIR`. When the user passes it through, the task trusts it as its scratch space. The sandbox must make that variable name a folder the task can write, or such tools fail.',
    from: ['sandbox-temp-vars.unsafe'],
    needs: ['sandbox', 'pass-through-env'],
    workspace: isoOne(
      'echo x > "$TMP/f" && mkdir -p dist && cat "$TMP/f" > dist/out.txt',
      {},
      {},
      {
        passThrough: ['TMP'],
      },
    ),
    steps: [
      { write: { '.home/hosttmp/.keep': '' } },
      {
        run: 'build',
        env: { TMP: '$ROOT/.home/hosttmp' },
        expect: { exit: 0, files: { [out('a')]: 'x\n' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/closed-temp-writable',
    title: 'A task closed off from the machine may still use its temp folder',
    why: 'Closing a task off hides the machine’s files, but tools still need scratch space. The temp folder is empty and private, so nothing in it is an input. A closed sandbox without one cannot run real tools.',
    from: ['sandbox-hermetic.unsafe', 'sandbox-temp-vars.unsafe'],
    workspace: one(closed(`echo t > "${T}/f" && read l < "${T}/f" && echo "$l" > out.txt`)),
    steps: passes({ [`${A}/out.txt`]: 't\n' }),
  }),
]

const runs: Case[] = [
  sandboxCase({
    id: 'sandbox/refused-run-not-cached',
    title: 'An isolated task that broke isolation is not cached, so the next run tries it again',
    why: 'The task ignored a refused write and exited 0, but what it did is not what it would do outside the sandbox. Saving that result would replay it as good forever. The next run must run the task again and fail again.',
    from: ['sandbox-records-key.unsafe', 'sandbox-grants.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/a.txt > dist/out.txt && { echo x > stray.txt; } 2>/dev/null; true',
    ),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { run: 'build', expect: { exit: 'fail', ran: ['a#build'] } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/granted-after-refusal-reruns',
    title: 'Granting the read an isolated task was refused makes the next run pass',
    why: 'The usual fix for a refused read is to grant it. The failed run saved nothing, so the next run must run the task again with the new grant. A tool that cached the failure, or kept the old grant, would leave the user stuck.',
    from: ['sandbox-fix', 'sandbox-records-key.unsafe'],
    workspace: isoOne(
      'mkdir -p dist && cat src/a.txt config.txt > dist/out.txt',
      {},
      {
        'config.txt': 'c\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      {
        configure: (ws) => {
          const a = ws.projects['a']!
          const build = a.tasks!['build']!
          return {
            ...ws,
            projects: {
              a: { ...a, tasks: { build: { ...build, sandbox: { read: ['config.txt'] } } } },
            },
          }
        },
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nc\n' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/declared-env-reaches-isolated-task',
    title: 'A variable an isolated task declares reaches it',
    why: 'Isolation hides what a task did not declare, not what it did. A declared variable keys the task, so passing it in is safe. A sandbox that rebuilds the environment and drops it breaks every task that reads a mode or a target.',
    from: ['sandbox-parent-env.unsafe', 'sandbox-helper-env.unsafe'],
    needs: ['sandbox', 'env-inputs'],
    workspace: isoOne(
      'mkdir -p dist && printf %s "$MODE" > dist/out.txt',
      {},
      {},
      { env: ['MODE'] },
    ),
    steps: [
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0, files: { [out('a')]: 'prod' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/pass-through-env-reaches-isolated-task',
    title: 'A variable an isolated task passes through reaches it',
    why: 'A passed-through variable, such as a token for a registry, is declared even though it does not key the task. The user asked for it to reach the command. A sandbox that drops it fails the task for doing what it said.',
    from: ['sandbox-parent-env.unsafe'],
    needs: ['sandbox', 'pass-through-env'],
    workspace: isoOne(
      'mkdir -p dist && printf %s "$CI_FLAG" > dist/out.txt',
      {},
      {},
      {
        passThrough: ['CI_FLAG'],
      },
    ),
    steps: [
      { run: 'build', env: { CI_FLAG: 'yes' }, expect: { exit: 0, files: { [out('a')]: 'yes' } } },
    ],
  }),

  sandboxCase({
    id: 'sandbox/closed-declared-env-reaches',
    title: 'A variable declared by a task closed off from the machine still reaches it',
    why: 'Closing a task off from the machine’s files does not mean dropping what it declared. The variable keys the task, so its value is an input like any file. A closed sandbox that hides it gives the task less than it asked for.',
    from: ['sandbox-hermetic.unsafe', 'sandbox-parent-env.unsafe'],
    needs: ['sandbox', 'env-inputs'],
    workspace: one(closed('echo "$MODE" > out.txt', { env: ['MODE'] })),
    steps: [
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, files: { [`${A}/out.txt`]: 'prod\n' } },
      },
    ],
  }),

  sandboxCase({
    id: 'sandbox/isolated-timeout-kills',
    title: 'An isolated task that runs past its time limit is stopped and fails',
    why: 'The time limit guards against a hung build, and isolation must not hide the task from the runner’s clock. A sandbox wrapper that the limit does not reach lets the task run on. The run must end in time with the task failed.',
    from: ['sandbox-timeout-clock.unsafe'],
    needs: ['sandbox', 'timeout'],
    workspace: isoOne('sleep 30 && mkdir -p dist && echo x > dist/out.txt', {}, {}, { timeout: 2 }),
    steps: [{ run: 'build', expect: { exit: 'fail', within: 25, files: { [out('a')]: null } } }],
  }),

  // turborepo#9666: a task's backgrounded children outlived the run.
  sandboxCase({
    id: 'sandbox/isolated-task-leaves-no-process',
    title: 'A background process an isolated task starts does not outlive the run',
    why: 'An isolated task’s processes are part of the task. One left running can keep writing after the task was saved, or hold a port the next run needs. Ending the task ends everything it started.',
    from: ['sandbox-lifecycle.unsafe', 'sandbox-runtime.unsafe'],
    workspace: isoOne('(sleep 300 &) ; mkdir -p dist && cat src/a.txt > dist/out.txt'),
    steps: [{ run: 'build', expect: { exit: 0, alone: true, files: { [out('a')]: 'a\n' } } }],
  }),

  sandboxCase({
    id: 'sandbox/refused-task-dependents-skipped',
    title: 'The tasks that depend on an isolated task that broke isolation do not run',
    why: 'The task exited 0, but the run fails it for the write it hid. What depends on it would build from a result that is not what the task really makes. A failure skips its dependents, and this is a failure.',
    from: ['sandbox-records-key.unsafe', 'sandbox-usage.unsafe'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: iso(
              'mkdir -p dist && cat src/a.txt > dist/out.txt && { echo x > stray.txt; } 2>/dev/null; true',
            ),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/dist/out.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['app#build'],
          files: { 'packages/app/dist/out.txt': null },
        },
      },
    ],
  }),
]

const network: Case[] = [
  sandboxCase({
    id: 'sandbox/network-granted-reaches-local-server',
    title: 'An isolated task granted a server’s port reaches the server the run started',
    why: 'Integration tests talk to a server another task started. The user granted the network on purpose, so the connection is expected. A sandbox that still blocks it leaves such tests no way to run isolated.',
    from: ['sandbox-loopback-reach.unsafe', 'sandbox-host-services.unsafe'],
    needs: ['sandbox', 'persistent', 'ready'],
    workspace: {
      projects: {
        a: {
          tasks: {
            serve: { command: serve(47821), persistent: { ready: 'listening' } },
            build: { ...iso(fetch(47821), { network: ['localhost:47821'] }), dependsOn: ['serve'] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: passes({ [out('a')]: 'pong' }),
  }),

  sandboxCase({
    id: 'sandbox/network-grant-is-per-task',
    title: 'A network grant on one task does not let another task of the run reach the network',
    why: 'The task without the grant has no network in its key, so a reply would change its output silently. One task’s grant must not open the network for all. The granted task gets the reply and the other fails.',
    from: ['sandbox-network-per-task.unsafe', 'sandbox-proxy-denials.unsafe'],
    needs: ['sandbox', 'persistent', 'ready'],
    workspace: {
      projects: {
        srv: { tasks: { serve: { command: serve(47822), persistent: { ready: 'listening' } } } },
        a: {
          tasks: {
            build: {
              ...iso(fetch(47822), { network: ['localhost:47822'] }),
              dependsOn: ['srv#serve'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: { ...iso(fetch(47822)), dependsOn: ['srv#serve'] } },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['a', 'b'],
        expect: {
          exit: 'fail',
          files: { [out('a')]: 'pong' },
          filesNot: { [out('b')]: 'pong' },
        },
      },
    ],
  }),
]

const all = [...reads, ...deps, ...writes, ...temp, ...runs, ...network]

/**
 * Cases vx fails today, each a correct expectation. On Linux a write grant
 * is a bind mount, and a mount point cannot be removed: `rm -rf dist` under
 * `dist/` meets "Read-only file system" (vx names the fix in its hint).
 */
const PENDING = new Set(['sandbox/clean-and-rebuild-output-dir-passes'])

export const pending: Case[] = all.filter((c) => PENDING.has(c.id))

export default all.filter((c) => !PENDING.has(c.id))
