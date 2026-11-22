// How a task's command runs, drawn from moon's exec tests
// (crates/cli/tests/exec_test.rs: supports_multi_commands_ampersand,
// supports_multi_commands_semicolon, supports_pipes, supports_redirects,
// supports_inline_vars, supports_expansion, supports_nested_commands,
// supports_nested_commands_with_tick, runs_from_project_root,
// runs_a_root_level_task) and Vite Task's e2e fixtures (exit_codes
// chained_command_with_&&_stops_at_first_failure, task_no_trailing_newline).
// A task is one shell command: every case holds a tool to running the
// bytes a user wrote through `sh`, in the project's directory, unchanged.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

const OUT = 'packages/a/dist/out.txt'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** One project whose build runs `command`; the run must leave `out` in dist/out.txt. */
function shell(
  id: string,
  title: string,
  why: string,
  command: string,
  out: string | null,
  exit: 0 | 'fail' = 0,
  files: Record<string, string> = { 'src/a.txt': 'a\n' },
) {
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['task-shell', 'runner'],
    workspace: one(task(command), files),
    steps: [{ run: 'build', expect: { exit, files: { [OUT]: out } } }],
  })
}

export default [
  // exec_test.rs supports_multi_commands_ampersand; Vite Task exit_codes chained_command_with_&&
  shell(
    'command-and-list-stops-at-first-failure',
    'A command `false && …` stops at the failure: nothing after it runs, and the task fails',
    'Chaining steps with `&&` is how a task says “only if the previous step passed”. A tool that splits the chain into steps of its own, or runs it through a shell that ignores the status, writes the output of a build whose first step failed. The run must fail and leave nothing the later steps would have written.',
    'false && mkdir -p dist && echo late > dist/out.txt',
    null,
    'fail',
  ),

  // exec_test.rs supports_multi_commands_semicolon
  shell(
    'command-semicolon-runs-every-step',
    'A command of steps joined by `;` runs each one in order',
    'A `;` list runs every step whatever the one before returned, and in the order written. A tool that keeps only the first step, or reorders them, leaves a different file than the same line typed in a terminal. The output must hold both lines, first then second.',
    'mkdir -p dist; echo first > dist/out.txt; echo second >> dist/out.txt',
    'first\nsecond\n',
  ),

  shell(
    'command-semicolon-status-is-the-last-step',
    'A `;` list whose first step fails and last step passes succeeds, as the shell says',
    'In `sh`, the status of a `;` list is the status of its last command. A tool that fails the task on an earlier step’s status runs something other than the command the user wrote, and a task meant to tolerate a failing probe can never pass. The run succeeds and the last step’s file is there.',
    'false; mkdir -p dist && echo ok > dist/out.txt',
    'ok\n',
  ),

  // exec_test.rs supports_pipes
  shell(
    'command-pipe',
    'A command that pipes one program into another writes what the pipe produced',
    'Pipes are the most common shell idiom in a task: a generator into a formatter, a list into a filter. A tool that does not run the command through a shell passes `|` as an argument to the first program. The output holds the transformed text.',
    'mkdir -p dist && cat src/a.txt | tr a-z A-Z > dist/out.txt',
    'A\n',
  ),

  shell(
    'command-pipeline-status-is-the-last-program',
    'A pipeline whose first program fails and last program passes succeeds, as `sh` says',
    'A plain `sh` pipeline returns the status of its last program; only `set -o pipefail` changes that, and the user did not write it. A tool that runs commands with pipefail on, or under another shell, fails a task the user’s own terminal passes. The run succeeds.',
    'mkdir -p dist && false | cat > dist/out.txt && echo ok >> dist/out.txt',
    'ok\n',
  ),

  shell(
    'command-or-list-falls-back',
    'A command `false || …` runs the fallback and succeeds',
    'An `||` fallback is how a task tolerates a step that may fail: a cache warmer, an optional tool. The status of the list is the fallback’s. A tool that fails the task on the first step’s status breaks every such command. The fallback’s file is there and the run succeeds.',
    'false || { mkdir -p dist && echo fallback > dist/out.txt; }',
    'fallback\n',
  ),

  // exec_test.rs supports_redirects
  shell(
    'command-redirects-stderr-into-a-file',
    'A command redirecting its error stream into a file writes it there',
    'A task that captures a tool’s diagnostics with `2>` relies on the shell to open the file. A tool that runs the command without a shell, or captures stderr itself before the redirect applies, leaves the file empty. The file holds what the command wrote to its error stream.',
    'mkdir -p dist && { echo oops >&2; } 2> dist/out.txt',
    'oops\n',
  ),

  // exec_test.rs supports_inline_vars
  shell(
    'command-inline-variable',
    'A variable set in front of a program, `FOO=bar prog`, reaches that program',
    'Setting a variable for one program is plain shell (`NODE_ENV=production vite build`). A tool that splits the command on spaces runs a program named `FOO=bar`. The program sees the value the command gave it.',
    'mkdir -p dist && FOO=bar sh -c \'echo "$FOO"\' > dist/out.txt',
    'bar\n',
  ),

  // exec_test.rs supports_expansion, supports_nested_commands
  shell(
    'command-substitution',
    'A command substitution, `$(…)`, is replaced by what it printed',
    'Tasks compute values inline: `--version=$(git describe)`, `$(cat VERSION)`. The shell runs the inner command and splices its output in. A tool that passes the text through unexpanded writes `$(cat src/a.txt)` into the output. The output holds the expanded text.',
    'mkdir -p dist && echo "$(cat src/a.txt)x" > dist/out.txt',
    'ax\n',
  ),

  // exec_test.rs supports_nested_commands_with_tick
  shell(
    'command-backtick-substitution',
    'A backtick substitution is replaced by what it printed',
    'Backticks are the older spelling of `$(…)` and still common in scripts copied into configs. The shell runs the inner command and splices its output in. A tool that treats backticks as text writes them into the output. The output holds the expanded text.',
    'mkdir -p dist && echo "`cat src/a.txt`y" > dist/out.txt',
    'ay\n',
  ),

  shell(
    'command-subshell-cd-does-not-leak',
    'A `cd` inside parentheses does not move the rest of the command',
    'A subshell runs its steps in a child shell: `(cd sub && make)` leaves the outer command where it was. A tool that runs each step of the command in turn in one process, or strips the parentheses, writes the output into the wrong directory. The output lands in the project’s dist.',
    'mkdir -p sub dist && (cd sub && echo inner > inner.txt) && basename "$PWD" > dist/out.txt',
    'a\n',
  ),

  shell(
    'command-over-several-lines',
    'A command written over several lines runs every line, in order',
    'A long task is often written one step per line. In `sh`, a newline ends a command like `;` does. A tool that keeps only the first line, or joins the lines into one argument list, runs part of the task and passes. The output holds every line’s write.',
    'mkdir -p dist\necho one > dist/out.txt\necho two >> dist/out.txt',
    'one\ntwo\n',
  ),

  shell(
    'command-here-document',
    'A here-document in a command writes the lines it holds',
    'A here-document is how a command writes a small file inline: a config, a banner. The shell reads the lines up to the marker as the program’s input. A tool that runs the first line alone leaves the shell waiting for input or writes nothing. The file holds the document’s lines.',
    'mkdir -p dist && cat > dist/out.txt <<EOF\nhello\nworld\nEOF\n',
    'hello\nworld\n',
  ),

  shell(
    'command-single-quotes-keep-a-glob',
    'A glob inside single quotes reaches the program as text, not as file names',
    "Quoting is how a command passes a pattern to a program that expands it itself (`eslint 'src/**/*.ts'`). The shell must not expand a quoted glob. A tool that strips quotes or expands it anyway hands the program a list of files it did not ask for. The program sees the pattern.",
    "mkdir -p dist && echo 'src/*.txt' > dist/out.txt",
    'src/*.txt\n',
  ),

  shell(
    'command-unquoted-glob-expands',
    'An unquoted glob in a command expands to the matching files, sorted',
    'An unquoted glob is the shell’s to expand, in sorted order, before the program runs. A tool that passes the pattern through hands the program a file named `src/*.txt`. The program sees each matching name.',
    'mkdir -p dist && echo src/*.txt > dist/out.txt',
    'src/a.txt src/b.txt\n',
    0,
    { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
  ),

  shell(
    'command-single-quoted-dollar-is-text',
    'A `$NAME` inside single quotes reaches the program as text',
    'Single quotes keep everything literal: a regex with `$`, a template with `${name}`. A tool that expands variables in the command itself before the shell sees it rewrites what the user wrote. The program sees the dollar sign and the name.',
    "mkdir -p dist && echo '${HOME}x' > dist/out.txt",
    '${HOME}x\n',
  ),

  shell(
    'command-braces-reach-the-shell-unchanged',
    'Text in braces such as `{projectRoot}` reaches the shell as written, never filled in by the tool',
    'A command is the user’s shell line, run as written. A tool that fills in its own placeholders inside it changes what runs: a JSON literal, a brace expansion or a template a program reads can hold the same words. The program sees the braces and the word.',
    "mkdir -p dist && echo '{projectRoot} {args.x}' > dist/out.txt",
    '{projectRoot} {args.x}\n',
  ),

  // Vite Task task_no_trailing_newline
  shell(
    'command-output-without-trailing-newline',
    'A command whose last output has no newline still succeeds and writes its file',
    'Plenty of programs end their output without a newline (`printf`). The tool must pass the bytes through and not wait for a line that never ends. A tool that waits hangs the run, and one that appends a newline changes the file. The file holds exactly what was written.',
    "mkdir -p dist && printf 'no newline' | tee dist/out.txt",
    'no newline',
  ),

  // exec_test.rs runs_from_project_root
  shell(
    'command-runs-in-project-directory',
    'A task’s command runs in its project’s directory',
    'Every relative path in a command (`src/`, `dist/`, `tsconfig.json`) means the project’s own. A tool that runs commands from the workspace root reads and writes another tree. The command sees its project’s directory as the current one.',
    'mkdir -p dist && basename "$PWD" > dist/out.txt',
    'a\n',
  ),

  defineCase({
    id: 'env/command-runs-in-project-directory-from-a-subdirectory',
    category: 'env',
    kind: 'correctness',
    title:
      'Run from a subdirectory of the project, the command still runs in the project’s directory',
    why: 'Where the user stands decides what is selected, not where the command runs. A tool that starts the command in the user’s current directory makes every relative path in it point somewhere else depending on where the run was typed. The command sees its project’s directory.',
    from: ['task-shell', 'member-cwd'],
    workspace: one(task('mkdir -p dist && basename "$PWD" > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'src/deep/b.txt': 'b\n',
    }),
    steps: [
      { run: 'build', cwd: 'packages/a/src/deep', expect: { exit: 0, files: { [OUT]: 'a\n' } } },
    ],
  }),

  // exec_test.rs runs_a_root_level_task
  defineCase({
    id: 'env/root-task-runs-at-the-workspace-root',
    category: 'env',
    kind: 'correctness',
    title: 'The workspace-root project’s task runs in the workspace root',
    why: 'A root task (a repo-wide lint, a docs build) works on the whole tree from the root. A tool that runs it in some member, or in a scratch directory, reads the wrong files. The command reads the root’s own `src/r.txt`, which only the root holds.',
    from: ['task-shell', 'runner'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { build: task('mkdir -p dist && cat src/r.txt > dist/out.txt') } },
        a: { files: { 'src/a.txt': 'a\n' } },
      },
      files: { 'src/r.txt': 'r\n' },
    },
    steps: [{ run: 'build', expect: { exit: 0, files: { 'dist/out.txt': 'r\n' } } }],
  }),
]
