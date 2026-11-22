// Outcomes drawn from Nix's functional tests (tests/functional) beyond the
// build, check and sandbox basics nix-functional.ts, nix-sandbox.ts,
// nix-shell.ts and mined-vitenix.ts carry: what `--check` compares
// (check.sh), path hashing without git (hash-path.sh, filter-source.sh),
// `--rebuild` and read-only substituters (binary-cache.sh), and what a
// store keeps apart (optimise-store.sh hard-links equal files, repair.sh
// mends a damaged path, nars.sh refuses special files).
import { defineCase, MEET, type Case, type TaskSpec } from '../src/spec.ts'
import { CONCAT, chainProject, one, out } from './shapes.ts'

const A = 'packages/a'
const SCRATCH = `../../${MEET}`

const cached = (command: string, outputs = ['dist/**']): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs,
})

/** Runs `first` on the task's first build and `second` on every later one: a task that is not reproducible. */
const twice = (first: string, second: string, outputs = ['dist/**']): TaskSpec =>
  cached(
    `mkdir -p dist ${SCRATCH} && if [ -e ${SCRATCH}/once ]; then ${second}; else ${first}; fi && touch ${SCRATCH}/once`,
    outputs,
  )

/** Writes the number of times it has run, counting across runs. */
const COUNTER = cached(
  `mkdir -p dist ${SCRATCH} && n=$(cat ${SCRATCH}/n 2>/dev/null || echo 0) && n=$((n+1)) && echo $n > ${SCRATCH}/n && echo $n > dist/out.txt`,
)

const check = (task: TaskSpec, files: Record<string, string> = { 'src/a.txt': 'a\n' }) => ({
  needs: ['determinism-check' as const],
  workspace: one(task, files),
  steps: [
    { run: 'build', expect: { exit: 0 as const } },
    { run: 'build', verify: true as const, expect: { exit: 'fail' as const } },
  ],
})

const passes = (task: TaskSpec) => ({
  needs: ['determinism-check' as const],
  workspace: one(task),
  steps: [
    { run: 'build', expect: { exit: 0 as const } },
    { run: 'build', verify: true as const, expect: { exit: 0 as const } },
  ],
})

const NO_GIT = { sh: 'rm -rf .git' }

export default [
  // check.sh "nondeterministic": --check compares the whole output tree, so a file only the rebuild writes is a difference.
  defineCase({
    id: 'cache/check-run-catches-an-extra-file',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild writes one more file than the stored result',
    why: 'A check run asks whether the stored result is what the task makes. A rebuild that leaves a file the stored result lacks makes something else, even when every file both hold is the same. A check that compares only the files the entry lists never sees the new one, and passes a task whose replays miss a file.',
    from: ['artifact-roundtrip'],
    ...check(twice('echo a > dist/a.txt', 'echo a > dist/a.txt && echo x > dist/extra.txt')),
  }),

  // check.sh "nondeterministic", the other way: a file the rebuild no longer writes.
  defineCase({
    id: 'cache/check-run-catches-a-missing-file',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild leaves out a file the stored result holds',
    why: 'A file the first build wrote and the rebuild does not is a difference in what the task makes. A check that compares only the files the rebuild wrote finds nothing wrong, and the stored file goes on being replayed though the task no longer makes it. Dropping a file is as much a sign of nondeterminism as changing one.',
    from: ['artifact-roundtrip'],
    ...check(twice('echo a > dist/a.txt && echo x > dist/extra.txt', 'echo a > dist/a.txt')),
  }),

  // check.sh with hash-path.sh: a NAR records the executable bit, so a mode-only difference fails --check.
  defineCase({
    id: 'cache/check-run-catches-an-executable-bit-difference',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild makes a script executable that was not before',
    why: 'A replay restores the mode with the bytes, and a script that is executable on one machine and not on another runs on one and fails on the other. A rebuild that changes only the executable bit therefore made something different. A check that compares contents alone passes it.',
    from: ['restore-dir-mode'],
    ...check(
      twice(
        "printf 'echo hi\\n' > dist/a.sh",
        "printf 'echo hi\\n' > dist/a.sh && chmod +x dist/a.sh",
      ),
    ),
  }),

  // check.sh with symlinks.sh: a link's target is part of the output, so a retarget fails --check.
  defineCase({
    id: 'cache/check-run-catches-a-retargeted-link',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild points an output link at another file',
    why: 'An output link is replayed as the link, so its target is part of what the task makes. Here both targets hold the same bytes, which a check that follows links would compare as equal. The link still names another file, and a later change to either target makes the two builds behave differently.',
    from: ['output-links'],
    ...check(
      twice(
        'echo 1 > dist/one && echo 1 > dist/two && ln -s one dist/l',
        'echo 1 > dist/one && echo 1 > dist/two && ln -s two dist/l',
      ),
    ),
  }),

  // check.sh with nars.sh: a NAR tells a link from a file, so a file turned link fails --check.
  defineCase({
    id: 'cache/check-run-catches-a-file-turned-into-a-link',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild writes a link where it first wrote a file',
    why: 'A file and a link to a file of the same bytes read alike, but they are not the same output. A replay writes one or the other, and a tool that copies, packs or edits the output treats them differently. A check that reads through the link sees equal bytes and misses the change of shape.',
    from: ['output-shape'],
    ...check(
      twice('echo 1 > dist/one && echo 1 > dist/l', 'echo 1 > dist/one && ln -s one dist/l'),
    ),
  }),

  // check.sh "deterministic": the build log may differ between builds; only the output is compared.
  defineCase({
    id: 'cache/check-run-ignores-what-the-task-prints',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run passes a task that prints the time but writes the same files',
    why: 'A build log holds timestamps, durations and process ids that differ on every run. What a check must judge is what the task leaves behind, since that is what a replay restores. A check that compared the log would fail nearly every task and be switched off.',
    from: ['replay-fidelity'],
    ...passes(
      cached(
        'mkdir -p dist && date +%s%N && od -An -N8 -tx8 /dev/urandom && echo same > dist/out.txt',
      ),
    ),
  }),

  // check.sh checkBuildTempDirRemoved: what a build leaves outside its outputs is thrown away, never compared.
  defineCase({
    id: 'cache/check-run-ignores-files-outside-the-outputs',
    category: 'cache',
    kind: 'correctness',
    title:
      'A check run passes a task whose scratch file outside its outputs differs on every build',
    why: 'A task often leaves logs or temporary files beside its outputs. They are not stored, so a replay never brings them back and no later task reads them from the cache. A check that compared them would flag a task whose stored result is perfectly reproducible.',
    from: ['restore-declared-only'],
    ...passes(
      cached(
        'mkdir -p dist tmp && od -An -N8 -tx8 /dev/urandom > tmp/scratch.txt && echo same > dist/out.txt',
      ),
    ),
  }),

  // check.sh "failed": a check whose rebuild fails is a failure, and the valid path it checked is kept.
  defineCase({
    id: 'cache/check-run-of-a-rebuild-that-fails-fails',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails when the rebuild exits non-zero, and the stored result still replays',
    why: 'A rebuild that fails did not reproduce the stored result, so the check cannot pass. The stored result was made by a build that passed and is still the right one for those inputs. A check that lets the failed rebuild remove it turns a flaky failure into a rebuild on every machine.',
    from: ['task-save'],
    needs: ['determinism-check'],
    workspace: one(twice('cat src/a.txt > dist/out.txt', 'exit 1')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', verify: true, expect: { exit: 'fail' } },
      { write: { [out('a')]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // check.sh "nondeterministic" over a workspace-level output: every output the task declares is compared.
  defineCase({
    id: 'cache/check-run-catches-a-difference-in-a-root-output',
    category: 'cache',
    kind: 'correctness',
    title:
      'A check run fails a task whose rebuild changes the file it writes at the workspace root',
    why: 'An output outside the project’s directory is stored and replayed like the others. A check that compares only the project’s own tree passes a task whose root file differs between builds. Every machine that replays it then gets whichever build happened to be stored.',
    from: ['artifact-roundtrip'],
    needs: ['determinism-check'],
    workspace: one({
      command: `mkdir -p dist ../../gen ${SCRATCH} && echo same > dist/out.txt && if [ -e ${SCRATCH}/once ]; then echo 2 > ../../gen/a.txt; else echo 1 > ../../gen/a.txt; fi && touch ${SCRATCH}/once`,
      inputs: ['src/**'],
      outputs: ['dist/**'],
      rootOutputs: ['gen/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', verify: true, expect: { exit: 'fail' } },
    ],
  }),

  // check.sh compares NAR hashes, not sizes or times: a same-size change with the same mtime still fails.
  defineCase({
    id: 'cache/check-run-catches-a-same-size-change',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild writes other bytes of the same length and time',
    why: 'Size and modification time are a cheap guess at whether a file changed, and here they agree. Only the bytes differ. A check that trusts the guess passes a task whose two builds disagree, which is the one thing it exists to catch.',
    from: ['restore-mtime'],
    ...check(
      twice(
        'echo aaaa > dist/out.txt && touch -d @946684800 dist/out.txt',
        'echo bbbb > dist/out.txt && touch -d @946684800 dist/out.txt',
      ),
    ),
  }),

  // check.sh with output-normalization.sh: Nix pins output times, so a time that differs is no difference.
  defineCase({
    id: 'cache/check-run-ignores-a-modification-time-difference',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run passes a task whose rebuild writes the same bytes with another file time',
    why: 'Every rebuild writes its files at a new time, and some tasks set times of their own. A replay dates the files it writes anyway, so the stored time is not part of what the task makes. A check that compared archives with their timestamps would fail every reproducible task.',
    from: ['restore-mtime'],
    ...passes(
      twice(
        'echo same > dist/out.txt && touch -d @946684800 dist/out.txt',
        'echo same > dist/out.txt && touch -d @1262304000 dist/out.txt',
      ),
    ),
  }),

  // check.sh: a NAR is an ordered tree, so contents swapped between two names is a different output.
  defineCase({
    id: 'cache/check-run-catches-contents-swapped-between-files',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild swaps what two of its files hold',
    why: 'Both builds write the same two contents, only under each other’s names. A check that compares the set of content hashes without the paths sees nothing wrong. Every reader of either file still gets something else from one build to the next.',
    from: ['artifact-roundtrip'],
    ...check(
      twice(
        'echo 1 > dist/a.txt && echo 2 > dist/b.txt',
        'echo 2 > dist/a.txt && echo 1 > dist/b.txt',
      ),
    ),
  }),

  // check.sh with nar-access.nix: every entry of the tree is compared, hidden files too.
  defineCase({
    id: 'cache/check-run-catches-a-difference-in-a-dotfile',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild changes only a dotfile among its outputs',
    why: 'Dotfiles are outputs like any other: a `.env` a build writes, a `.map` index, a manifest. A replay restores them, so they must be compared. A check that walks the outputs with a plain `*` skips them and passes a task whose hidden file differs.',
    from: ['artifact-roundtrip'],
    ...check(
      twice(
        'echo same > dist/out.txt && echo 1 > dist/.meta',
        'echo same > dist/out.txt && echo 2 > dist/.meta',
      ),
    ),
  }),

  // hash-path.sh / filter-source.sh: without git, a path is hashed by reading it, new files too.
  defineCase({
    id: 'inputs/without-git-new-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, a new file under the inputs runs the task again',
    why: 'Without git there is no list of tracked files to start from, so the tool must walk the input globs itself. A walk done once and remembered, or one that hashes only files it saw before, misses the new file. The task then replays a build that never read it.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nb\n' } } },
    ],
  }),

  // hash-path.sh: a deleted file changes the hash of the tree it was in.
  defineCase({
    id: 'inputs/without-git-deleted-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'In a workspace that is not a git repository, deleting an input runs the task again',
    why: 'A deleted input changes what the task reads, so its result changes too. Without git the tool learns of the deletion only by walking the inputs again. A tool that keys only the files still there and remembers nothing of the old set can miss that one went.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT), { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' }),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nb\n' } } },
      { write: { [`${A}/src/b.txt`]: null } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // hash-path.sh: a NAR hash holds the executable bit, git or not.
  defineCase({
    id: 'inputs/without-git-executable-bit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, making an input executable runs the task again',
    why: 'Git records the executable bit for the files it tracks, and a tool keying files by reading them must record it too. A script that becomes executable changes what a task that runs or packs it produces. Hashing contents alone replays the build of the plain file.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(
      cached(
        'mkdir -p dist && cat src/a.txt > dist/out.txt && { [ -x src/a.txt ] && echo x || echo -; } >> dist/out.txt',
      ),
    ),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n-\n' } } },
      { chmod: { [`${A}/src/a.txt`]: 0o755 } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nx\n' } },
      },
    ],
  }),

  // symlinks.sh / hash-path.sh: a link is hashed as the link, its target text included.
  defineCase({
    id: 'inputs/without-git-link-retarget-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, pointing an input link at another file runs the task again',
    why: 'A link under the inputs decides which file the task reads through it. Without git the tool must read the link itself, not only list it. A tool that keys the link’s name and nothing else replays the build of the old target.',
    from: ['no-git-on-path', 'linked-inputs'],
    needs: ['without-git'],
    workspace: one(cached('mkdir -p dist && cat src/l.txt > dist/out.txt'), {
      'src/one.txt': 'one\n',
      'src/two.txt': 'two\n',
    }),
    steps: [
      NO_GIT,
      { link: { [`${A}/src/l.txt`]: 'one.txt' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { link: { [`${A}/src/l.txt`]: 'two.txt' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  // filter-source.sh: only what the filter keeps is hashed; the rest can change freely.
  defineCase({
    id: 'inputs/without-git-edit-outside-inputs-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'In a workspace that is not a git repository, editing a file outside the inputs replays the task',
    why: 'Without git a tool may fall back to hashing the whole project directory. The inputs still say what the task reads, and a README beside the sources is not among them. Rerunning on every edit to it throws the cache away exactly where git is missing, in a tarball or a container build.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT), { 'src/a.txt': 'a\n', 'README.md': 'one\n' }),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/README.md`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // binary-cache.sh: a path substituted outside any repository comes back whole.
  defineCase({
    id: 'outputs/without-git-deleted-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, a deleted output comes back from the cache',
    why: 'A replay restores outputs from the cache, which has nothing to do with git. Without git, though, a tool may decide what to clean or restore by asking git which files are its own. The deleted output must still come back with its bytes and the task must not run.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [out('a')]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // dependencies.sh: a dependency's new input reaches every derivation built on it.
  defineCase({
    id: 'cache/without-git-dependency-edit-cascades',
    category: 'cache',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, editing a library rebuilds it and the app on it',
    why: 'The app’s result depends on what the library built, so a new library source must reach the app’s key through the library’s. Without git the library’s key comes from reading its files, and the app’s must fold that in. Rebuilding the library alone leaves the app replaying a build on the old library.',
    from: ['no-git-on-path', 'hash-chain'],
    needs: ['without-git'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'lib\napp\n' } } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  // hash-path.sh: a NAR holds each name, so a rename is a new hash though the bytes are the same.
  defineCase({
    id: 'inputs/without-git-renamed-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'In a workspace that is not a git repository, renaming an input runs the task again',
    why: 'A file’s name is part of what a task reads: a bundler emits it, a test runner reports it, a glob orders by it. Hashing only the bytes of each file, without its path, makes the renamed tree look unchanged. The task then replays a build that names the old file.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached('mkdir -p dist && ls src > dist/out.txt')),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a.txt\n' } } },
      { sh: `mv ${A}/src/a.txt ${A}/src/b.txt` },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b.txt\n' } } },
    ],
  }),

  // filter-source.sh / nar-access.nix: a hidden file is part of the tree a path hashes.
  defineCase({
    id: 'inputs/without-git-dotfile-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, editing a dotfile under the inputs runs the task again',
    why: 'Git lists dotfiles like any other file, so a tool keying by git sees them. A walk of the file system written by hand often skips names starting with a dot, and `.babelrc` or `.env.defaults` under the sources then never keys the task. The edit replays a build made with the old config.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached('mkdir -p dist && cat src/a.txt src/.conf > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'src/.conf': 'one\n',
    }),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\none\n' } } },
      { write: { [`${A}/src/.conf`]: 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\ntwo\n' } } },
    ],
  }),

  // hash-path.sh hashes a tree by reading it; a task keyed by files never reads an empty folder.
  defineCase({
    id: 'inputs/without-git-empty-directory-added-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'In a workspace that is not a git repository, a new empty folder under the inputs replays the task',
    why: 'Input globs name files, and an empty folder adds none. With git the folder is invisible, since git tracks files only. A walk of the file system that keys directories as entries reruns the task here, so the same sources key differently with and without git.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: `mkdir ${A}/src/empty` },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // hash-path.sh: a path's hash is the same whatever found it; git or a walk must agree.
  defineCase({
    id: 'cache/removing-git-keeps-the-cache',
    category: 'cache',
    kind: 'efficiency',
    title: 'Deleting the `.git` folder of a built workspace still replays the task',
    why: 'The sources did not change, only the way the tool finds them. A Docker build that copies the checkout without `.git`, or a release tarball, should hit what CI built from the repository. A tool whose keys differ by how it listed the files rebuilds everything there.',
    from: ['no-git-on-path', 'gitlink-without-git'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      NO_GIT,
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // hash-path.sh, the other way: a folder put under git keeps the hashes it had.
  defineCase({
    id: 'cache/git-init-keeps-the-cache',
    category: 'cache',
    kind: 'efficiency',
    title: 'Making a built folder a git repository and committing it still replays the task',
    why: 'A project often starts as a plain folder and becomes a repository later. Its files are the same before and after the first commit. A tool that keys tracked files by git and loose files by reading them must reach the same key both ways, or the first commit throws the whole cache away.',
    from: ['no-git-on-path', 'gitlink-without-git'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'git init -q && git add -A && git commit -qm init' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // binary-cache.sh: a read-only substituter is never written, whatever the build did.
  defineCase({
    id: 'cache/forced-read-only-run-keeps-the-stored-bytes',
    category: 'cache',
    kind: 'correctness',
    title:
      'A forced run under a read-only cache runs the task and leaves the stored result as it was',
    why: 'A read-only cache promises not to write, and forcing the run asks only to ignore what is stored. Together the task runs and its new result goes nowhere. A tool that lets force win saves from a run that was told not to, which is how an untrusted branch overwrites the main branch’s entries.',
    from: ['download-policy'],
    needs: ['force', 'read-only-cache'],
    workspace: one(COUNTER),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: '1\n' } } },
      {
        run: 'build',
        force: true,
        readOnlyCache: true,
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '2\n' } },
      },
      { write: { [out('a')]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '1\n' } } },
    ],
  }),

  // optimise-store.sh: two hard-linked files of one output come back, each with its bytes.
  defineCase({
    id: 'outputs/hard-linked-outputs-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Two output files a task hard-linked to each other both come back on a replay',
    why: 'Build tools hard-link outputs to save space: a package copied into two places, a binary under two names. An archive stores the second name as a link to the first, and a restore that skips link entries, or writes them before their target, loses one. Both names must come back with the bytes the task wrote.',
    from: ['tar-roundtrip-fuzz'],
    workspace: one(
      cached('mkdir -p dist && cat src/a.txt > dist/a.txt && ln -f dist/a.txt dist/b.txt'),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [`${A}/dist/a.txt`]: 'a\n', [`${A}/dist/b.txt`]: 'a\n' },
        },
      },
    ],
  }),

  // optimise-store.sh hard-links equal store files; an edit to one restored copy must not reach the other.
  defineCase({
    id: 'outputs/equal-outputs-of-two-projects-stay-apart',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Two projects that build the same bytes get separate files: editing one leaves the other alone',
    why: 'A cache that stores equal contents once may hand both projects the same file on disk. An edit to one project’s output then lands in the other project and in the stored entry too. The next replay restores the edited bytes for both, and the cache is wrong without any task running.',
    from: ['restore-in-place'],
    workspace: {
      projects: {
        a: {
          tasks: { build: cached('mkdir -p dist && echo same > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
        b: {
          tasks: { build: cached('mkdir -p dist && echo same > dist/out.txt') },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build', 'b#build'] } },
      { write: { [`${A}/dist`]: null, 'packages/b/dist': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
      { sh: `printf x >> ${out('a')}` },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'same\n', [out('b')]: 'same\n' } },
      },
    ],
  }),

  // optimise-store.sh, within one output: equal files are two files to the user.
  defineCase({
    id: 'outputs/equal-files-of-one-task-stay-apart',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Two equal output files of one task come back as separate files: editing one leaves the other alone',
    why: 'Equal files in one output are common: license copies, empty markers, the same asset under two paths. A restore that writes the second as a hard link to the first ties them together, so an edit to one rewrites the other, and the stored entry too if it shares the file. The next replay must still give each its own bytes.',
    from: ['restore-in-place'],
    workspace: one(cached('mkdir -p dist && echo same > dist/x.txt && echo same > dist/y.txt')),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: `printf x >> ${A}/dist/x.txt` },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/x.txt`]: 'same\n', [`${A}/dist/y.txt`]: 'same\n' },
        },
      },
    ],
  }),

  // repair.sh mends a damaged path by writing it anew; nars.sh never writes into what stands there.
  defineCase({
    id: 'outputs/output-swapped-for-hard-link-to-a-source-not-written-through',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output a user replaced with a hard link to a source file is put back, and the source keeps its bytes',
    why: 'A hard link is the same file under two names. A replay that opens the output and writes over it in place writes into the source file as well, destroying the user’s work without a word. Putting the output back must replace the name, leaving the other name’s bytes alone.',
    from: ['restore-link-swap', 'restore-in-place'],
    workspace: one(cached('mkdir -p dist && echo built > dist/out.txt')),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: `ln -f ${A}/src/a.txt ${out('a')}` },
      {
        run: 'build',
        expect: { exit: 0, files: { [`${A}/src/a.txt`]: 'a\n', [out('a')]: 'built\n' } },
      },
    ],
  }),

  // nars.sh refuses special files; a restore must not open a FIFO where its output goes.
  defineCase({
    id: 'outputs/fifo-in-place-of-an-output-replaced',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A named pipe left where an output file goes is replaced by the file on the next run, without hanging',
    why: 'Opening a named pipe to write it waits until something reads it, so a replay that writes over the output in place never ends. Hashing it to see whether it changed waits the same way. The run must replace the pipe with the stored file and finish.',
    from: ['restore-occupied-parent', 'restore-artifact-replaced'],
    workspace: one(cached(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: `rm ${out('a')} && mkfifo ${out('a')}` },
      { run: 'build', expect: { exit: 0, within: 60 } },
      {
        sh: `if [ -f ${out('a')} ] && [ ! -p ${out('a')} ]; then echo file; else echo other; fi > verdict.txt`,
      },
      { run: 'build', expect: { exit: 0, within: 60, files: { 'verdict.txt': 'file\n' } } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // hash-path.sh / nars.sh: a link and a regular file are different entries even with the same bytes.
  defineCase({
    id: 'inputs/file-swapped-for-link-to-same-bytes-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Swapping an input for a link to a file of the same bytes runs the task again, and swapping it back replays',
    why: 'Git, a tar archive and a Nix store all record a link as a link. A task that copies, packs or lists its sources makes something different from a link than from a file, though reading through it gives the same bytes. Putting the plain file back is the first tree again, so its build replays.',
    from: ['linked-inputs', 'hash-scenarios'],
    workspace: one(cached('mkdir -p dist && ls -l src | grep -c "^l" > dist/out.txt || true'), {
      'src/a.txt': 'x\n',
      'src/b.txt': 'x\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: '0\n' } } },
      { link: { [`${A}/src/b.txt`]: 'a.txt' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '1\n' } } },
      { write: { [`${A}/src/b.txt`]: null } },
      { write: { [`${A}/src/b.txt`]: 'x\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '0\n' } } },
    ],
  }),

  // optimise-store.sh hard-links equal files and the hashes stay the same: a link of equal bytes changes nothing.
  defineCase({
    id: 'inputs/file-swapped-for-hard-link-to-equal-file-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Replacing an input with a hard link to another file of the same bytes replays the task',
    why: 'Deduplicating tools, package managers and backups replace equal files with hard links. The file is still a regular file with the same bytes and mode, only its inode and link count changed. A key that reads anything beyond the bytes and mode reruns the task for a tree no task can tell apart.',
    from: ['hash-scenarios', 'stale-hit'],
    workspace: one(cached(CONCAT), { 'src/a.txt': 'x\n', 'src/b.txt': 'x\n' }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: `ln -f ${A}/src/a.txt ${A}/src/b.txt` },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'x\nx\n' } } },
    ],
  }),

  // output-normalization.sh: Nix dates every output alike; a replay dates what it writes now, as a build would.
  defineCase({
    id: 'outputs/restored-dependency-output-is-newer-for-a-make-style-copy',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A library output brought back by a replay counts as newer than the copy the app kept, so the app picks it up',
    why: 'Many build steps copy or compile only what is newer than their own output, as make does. When a replay brings back an older library build, it has just been written, and the app’s copy from the newer build must count as out of date. A restore that stamps the file with the time it was first built makes the app keep the newer copy and save it under the older library’s key.',
    from: ['restore-mtime'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command:
                'mkdir -p dist && { [ dist/out.txt -nt ../lib/dist/out.txt ] || cp ../lib/dist/out.txt dist/out.txt; }',
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
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'lib\n' } } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'lib2\n' } } },
      { write: { 'packages/lib/src/a.txt': 'lib\n', 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { [out('lib')]: 'lib\n', [out('app')]: 'lib\n' },
        },
      },
    ],
  }),

  // repair.sh rewrites only the damaged path; a replay leaves the outputs that still match as they stand.
  defineCase({
    id: 'outputs/replay-rewrites-only-the-damaged-output',
    category: 'outputs',
    kind: 'efficiency',
    title:
      'A replay puts back the one output a user edited and leaves its untouched sibling as it was',
    why: 'Rewriting an output that already holds the stored bytes gives it a new time. A watcher, a dev server or a make-style step downstream then sees a change that never happened and rebuilds. Only the edited file needs writing, so its sibling keeps its time.',
    from: ['restore-in-place', 'restore-keep-rewrite'],
    workspace: one(cached('mkdir -p dist && echo x > dist/x.txt && echo y > dist/y.txt')),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        sh: `touch -d @946684800 ${A}/dist/y.txt && printf z > ${A}/dist/x.txt && stat -c %Y ${A}/dist/y.txt > before.txt`,
      },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/x.txt`]: 'x\n' } },
      },
      {
        sh: `if stat -c %Y ${A}/dist/y.txt | cmp -s - before.txt; then echo kept; else echo rewritten; fi > verdict.txt`,
      },
      {
        run: 'build',
        expect: { exit: 0, files: { 'verdict.txt': 'kept\n', [`${A}/dist/y.txt`]: 'y\n' } },
      },
    ],
  }),

  // shell.sh with binary-cache.sh: a dependency substituted from a cache still puts its bin/ on PATH.
  defineCase({
    id: 'env/restored-dependency-program-runs-by-name',
    category: 'env',
    kind: 'correctness',
    title:
      'A program a dependency built, deleted and brought back by a replay, still runs by name in its dependant',
    why: 'A dependant that rebuilds while its dependency replays needs the dependency’s programs back on disk, executable, before it starts. A replay that restores the file without its mode, or after the dependant started, leaves a command not found. The dependant must run the tool just as it did when the dependency built it.',
    from: ['task-shell', 'restore-dir-mode'],
    needs: ['dependency-bin'],
    workspace: {
      projects: {
        tools: {
          tasks: {
            build: {
              command: `mkdir -p out/bin && printf '#!/bin/sh\\necho tool\\n' > out/bin/hello && chmod +x out/bin/hello`,
              inputs: ['src/**'],
              outputs: ['out/**'],
              bin: 'out/bin',
            },
          },
          files: { 'src/a.txt': 'tool\n' },
        },
        app: {
          tasks: {
            build: {
              command: 'mkdir -p dist && hello > dist/out.txt && cat src/a.txt >> dist/out.txt',
              dependsOn: ['tools#build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { [out('app')]: 'tool\na\n' } },
      },
      { write: { 'packages/tools/out': null, 'packages/app/src/a.txt': 'b\n' } },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          notRan: ['tools#build'],
          ran: ['app#build'],
          files: { [out('app')]: 'tool\nb\n' },
        },
      },
    ],
  }),
  // check.sh with nar-access.nix: a NAR lists every directory, empty ones too.
  defineCase({
    id: 'cache/check-run-catches-a-new-empty-directory',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose rebuild leaves an empty folder the stored result lacks',
    why: 'A replay brings back the empty folders a task leaves under its outputs, since a later step may write into them or test for them. A rebuild that leaves one the first build did not made a different tree. A check that compares only files passes it.',
    from: ['output-empty-dir'],
    ...check(twice('echo a > dist/a.txt', 'echo a > dist/a.txt && mkdir dist/cache')),
  }),

  // hash-path.sh walks a tree it was handed; without git the tool walks it, and a link cycle must not trap it.
  defineCase({
    id: 'inputs/without-git-link-cycle-no-hang',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, a folder link back into the inputs neither hangs nor fails the run',
    why: 'With git the tool reads a list of files, and a link is one entry. Without git it walks the folders itself, and a walk that follows a link back to its own parent never ends. The run must key the files once and finish, and an edit must still run the task again.',
    from: ['no-git-on-path', 'linked-inputs'],
    needs: ['without-git'],
    workspace: one(cached('mkdir -p dist && cat src/a.txt > dist/out.txt')),
    steps: [
      NO_GIT,
      { link: { [`${A}/src/loop`]: '.' } },
      { run: 'build', expect: { exit: 0, within: 120, files: { [out('a')]: 'a\n' } } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, within: 120, ran: ['a#build'], files: { [out('a')]: 'b\n' } },
      },
    ],
  }),

  // hash-path.sh: a path is hashed by reading it, whatever repository happens to sit inside it.
  defineCase({
    id: 'inputs/without-git-project-holding-its-own-repository',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, a new file in a project that is a repository of its own runs its task again',
    why: 'A vendored project often keeps its own `.git` inside a workspace that has none. A tool that finds that repository and keys the project by what it tracks misses a file nobody committed there. The new file is still an input, and the task must run again.',
    from: ['no-git-on-path', 'gitlink-without-git'],
    needs: ['without-git'],
    workspace: one(cached(CONCAT)),
    steps: [
      NO_GIT,
      { sh: `cd ${A} && git init -q && git add -A && git commit -qm init` },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\nb\n' } } },
    ],
  }),

  // filter-source.sh over a path outside the package: without git, a workspace-level file is read like any other.
  defineCase({
    id: 'inputs/without-git-root-input-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a workspace that is not a git repository, editing a workspace-level file a task declares runs it again',
    why: 'A shared config at the workspace root, such as a `tsconfig.base.json`, keys every task that names it. Without git the tool must find and read it outside the project’s own folder. A tool that walks only the project when git is missing replays builds made with the old config.',
    from: ['no-git-on-path'],
    needs: ['without-git'],
    workspace: {
      ...one({
        command: 'mkdir -p dist && cat src/a.txt ../../conf/base.txt > dist/out.txt',
        inputs: ['src/**'],
        rootInputs: ['conf/**'],
        outputs: ['dist/**'],
      }),
      files: { 'conf/base.txt': 'one\n' },
    },
    steps: [
      NO_GIT,
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\none\n' } } },
      { write: { 'conf/base.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\ntwo\n' } } },
    ],
  }),
] satisfies Case[]

// vx keeps the first entry saved under a key: a forced run's new bytes are not stored.
export const pending: Case[] = [
  // binary-cache.sh rebuilds with --rebuild and copies the new path up: the fresh result replaces the old.
  defineCase({
    id: 'cache/forced-run-replaces-the-stored-bytes',
    category: 'cache',
    kind: 'correctness',
    title: 'After a forced run writes other bytes, the next replay restores the forced run’s bytes',
    why: 'A user forces a run because they no longer trust what is stored. If the task now writes something else, the stored result must become the new one. A cache that keeps the first entry for a key it already holds replays the very result the user asked to replace.',
    from: ['task-save'],
    needs: ['force'],
    workspace: one(COUNTER),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: '1\n' } } },
      {
        run: 'build',
        force: true,
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '2\n' } },
      },
      { write: { [out('a')]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: '2\n' } } },
    ],
  }),
]
