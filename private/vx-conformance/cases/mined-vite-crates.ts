// Outcomes drawn from Vite Task's crates: vt_shell (how a task's command
// line is parsed: quoting, `&&` chains, variables set in front of a
// program), fspy (which file accesses a traced task makes and a sandbox
// must judge), vt_workspace's package filter (directory selectors) and
// vt_glob (negations). Vite Task splits a command at `&&` and runs each
// part itself when it can parse it, so every shell case holds a tool to
// the outcome `sh` gives for the bytes the user wrote.
import {
  defineCase,
  type Case,
  type Selector,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { one } from './shapes.ts'

const A = 'packages/a'
const OUT = `${A}/dist/out.txt`

/** One project whose build runs `command`; the run must leave `out` in dist/out.txt. */
function shell(
  slug: string,
  title: string,
  why: string,
  command: string,
  out: string | null,
  exit: 0 | 'fail' = 0,
): Case {
  return defineCase({
    id: `env/${slug}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['task-shell', 'runner'],
    workspace: one({ command, inputs: ['src/**'], outputs: ['dist/**'] }),
    steps: [{ run: 'build', expect: { exit, files: { [OUT]: out } } }],
  })
}

const iso = (command: string): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  sandbox: {},
})

type Draft = Omit<Case, 'category' | 'kind' | 'needs'>
const sandboxCase = (c: Draft): Case =>
  defineCase({ category: 'sandbox', kind: 'correctness', needs: ['sandbox'], ...c })

/** Three projects under `packages/` and one under `apps/`, each building its own name. */
function spread(): WorkspaceSpec {
  const p = (name: string, dir?: string) => ({
    ...(dir ? { dir } : {}),
    tasks: {
      build: {
        command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    },
    files: { 'src/a.txt': `${name}\n` },
  })
  return {
    projects: { a: p('a'), b: p('b'), c: p('c'), web: p('web', 'apps/web') },
  }
}

const ALL = ['a#build', 'b#build', 'c#build', 'web#build']

function selectDir(
  slug: string,
  title: string,
  why: string,
  select: Selector[],
  ran: string[],
): Case {
  return defineCase({
    id: `graph/${slug}`,
    category: 'graph',
    kind: 'correctness',
    title,
    why,
    from: ['filter', 'select'],
    needs: ['filter', 'select-dir'],
    workspace: spread(),
    steps: [
      {
        run: 'build',
        select,
        expect: { exit: 0, ran, notRan: ALL.filter((t) => !ran.includes(t)) },
      },
    ],
  })
}

export default [
  // vt_shell/src/lib.rs test_parse_command: `A=B hello world && …` gives `A`
  // to `hello` alone.
  shell(
    'command-inline-variable-scoped-to-its-step',
    'A variable set in front of one program in an `&&` chain does not reach the next program',
    'A `NAME=value` prefix is the environment of that one program, not of the command line. A tool that splits the chain at `&&` and lifts every prefix into the task’s environment leaks the value into steps the user never gave it. The first program sees the value; the second sees it unset.',
    'mkdir -p dist && A=one sh -c \'echo "$A"\' > dist/out.txt && sh -c \'echo "${A-unset}"\' >> dist/out.txt',
    'one\nunset\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: an assignment with no program is
  // a statement of its own, not a prefix.
  shell(
    'command-assignment-alone-seen-later-not-exported',
    'A variable assigned on its own, `B=two && …`, is seen by later steps but not handed to programs',
    'An assignment with no program sets a shell variable for the rest of the line, without exporting it. A tool that reads it as a program named `B=two` fails the task; one that exports it hands the value to programs that should not see it. The later step expands it, and a child shell sees it unset.',
    'B=two && mkdir -p dist && echo "$B" > dist/out.txt && sh -c \'echo "${B-unset}"\' >> dist/out.txt',
    'two\nunset\n',
  ),

  // vt_shell/src/lib.rs try_parse_as_and_list: the prefix becomes the
  // program's environment, after its args are expanded.
  shell(
    'command-inline-variable-not-expanded-in-its-own-args',
    'A prefix `X=hi prog "$X"` does not fill in `$X` in that same program’s args',
    'The shell expands a program’s words before it applies the prefix, so `X=hi echo $X` prints what `X` was before. A tool that turns the prefix into the environment of the whole line, then expands, prints `hi` where the user’s terminal prints nothing. The arg holds the value from before the prefix: unset.',
    'mkdir -p dist && X=hi printf \'%s\\n\' "${X-unset}" > dist/out.txt',
    'unset\n',
  ),

  // vt_shell/src/lib.rs try_parse_as_and_list: `export` is a builtin, run by
  // the shell, not a program.
  shell(
    'command-export-reaches-later-programs',
    'A variable exported in one step of an `&&` chain reaches the programs of the later steps',
    'An `export` changes the environment of the shell itself, and every program it starts afterwards inherits it. A tool that runs each step of the chain as its own process loses the export after the first step. The child shell started later sees the value.',
    'export C=three && mkdir -p dist && sh -c \'echo "$C"\' > dist/out.txt',
    'three\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: `"arg\"2"` is one arg `arg"2`.
  shell(
    'command-escaped-quote-inside-double-quotes',
    'A `\\"` inside double quotes reaches the program as a plain double quote',
    'Inside double quotes a backslash escapes the quote, so `"arg\\"2"` is the one word `arg"2`. A tool that unquotes the command itself and ends the string at the escaped quote passes two words, or keeps the backslash. The program receives exactly `arg"2`.',
    'mkdir -p dist && printf \'%s\\n\' "arg\\"2" > dist/out.txt',
    'arg"2\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: `FOO="BE\"R" program` gives
  // `FOO` the value `BE"R`.
  shell(
    'command-inline-variable-value-with-escaped-quote',
    'A prefix value written `FOO="BE\\"R"` reaches the program as `BE"R`',
    'A value set in front of a program follows the same quoting as any word. A tool that lifts the prefix into an environment map with its own unquoting keeps the backslash or cuts the value at the inner quote. The program sees the value the shell would give it.',
    'mkdir -p dist && FOO="BE\\"R" sh -c \'printf "%s\\n" "$FOO"\' > dist/out.txt',
    'BE"R\n',
  ),

  // vt_shell/src/lib.rs test_parse_command, said of a quoted value holding a
  // space.
  shell(
    'command-inline-variable-value-with-space',
    'A prefix value in quotes holding a space, `X="a b" prog`, reaches the program whole',
    'Quotes make `a b` one value. A tool that splits the prefix at the space sets `X=a` and runs a program named `b`. The program sees `a b`.',
    'mkdir -p dist && X="a b" sh -c \'printf "[%s]\\n" "$X"\' > dist/out.txt',
    '[a b]\n',
  ),

  // vt_shell/src/lib.rs test_unquote_preserves_nested_quotes
  shell(
    'command-nested-quote-kinds',
    'Single quotes inside double quotes, and double inside single, reach the program as text',
    'Each kind of quote makes the other a plain character: `"hello \'world\'"` and `\'hello "world"\'`. A tool that strips every quote it finds, of either kind, hands the program `hello world` twice. Each arg keeps its inner quotes.',
    "mkdir -p dist && printf '%s\\n' \"hello 'world'\" 'hello \"world\"' > dist/out.txt",
    'hello \'world\'\nhello "world"\n',
  ),

  // vt_shell/src/lib.rs test_unquote_preserves_nested_quotes: `hello\ world`
  // is one arg.
  shell(
    'command-backslash-space-one-word',
    'A backslash before a space, `hello\\ world`, keeps the two halves one arg',
    'An escaped space is part of the word, the way a file name with a space is often typed. A tool that splits the command on spaces before the shell sees it passes `hello\\` and `world`. The program receives one arg, `hello world`.',
    "mkdir -p dist && printf '[%s]\\n' hello\\ world > dist/out.txt",
    '[hello world]\n',
  ),

  // vt_shell/src/lib.rs test_flatten_pieces_recursion: `"a\\b"` is `a\b`.
  shell(
    'command-double-quoted-backslash-pair',
    'Two backslashes inside double quotes reach the program as one',
    'Inside double quotes `\\\\` is an escaped backslash, so `"a\\\\b"` is `a\\b`. A tool that unquotes without handling escapes passes both backslashes, and a Windows-style path in a task arrives doubled. The program receives a single backslash.',
    'mkdir -p dist && printf \'%s\\n\' "a\\\\b" > dist/out.txt',
    'a\\b\n',
  ),

  // vt_shell/src/lib.rs test_parse_urllib_prepare: `;`, `(` and quotes inside
  // a quoted `node -e` script stay in the arg.
  shell(
    'command-operators-inside-quotes-are-text',
    'An `&&`, `;`, `|` or `||` inside quotes reaches the program as text, not as a split',
    'A tool that splits a command at `&&` before the shell reads it must respect quotes, or a quoted script such as `node -e "a(); if (x) b()"` is cut in pieces. Inside quotes every operator is a character. The program prints the whole string.',
    'mkdir -p dist && echo "a && b; c | d || e" > dist/out.txt',
    'a && b; c | d || e\n',
  ),

  // vt_shell/src/lib.rs test_parse_command, said of the shell’s left-to-right
  // reading of `&&` and `||`.
  shell(
    'command-and-or-read-left-to-right',
    'In `true || skip && next`, the step after `&&` still runs',
    '`&&` and `||` have equal precedence in `sh` and bind left to right, so the line reads `(true || skip) && next`. A tool that splits at `&&` first and then reads `||` within each part, or the other way round, runs something else. Here `skip` does not run and `next` does.',
    'mkdir -p dist && true || echo skipped > dist/out.txt && echo next >> dist/out.txt',
    'next\n',
  ),

  // vt_shell/src/lib.rs try_parse_as_and_list falls back to the shell for
  // what it cannot model; `!` is one such word.
  shell(
    'command-bang-inverts-status',
    'A `!` before a program turns its failure into success, and the chain goes on',
    '`! grep -q x file` is how a task asserts something is absent. A tool that takes `!` as a program name, or drops it, fails the step or inverts nothing. Here the search finds nothing, so the negated step passes and the next one writes the file.',
    'mkdir -p dist && ! grep -q zzz src/a.txt && echo absent > dist/out.txt',
    'absent\n',
  ),

  // vt_shell/src/lib.rs: a parser that splits at `&&` must know where a
  // comment starts.
  shell(
    'command-comment-ends-the-line',
    'Text after a ` #` is a comment up to the line’s end: an `&&` step written there never runs',
    'A comment runs to the end of the line, operators and all, and the next line is a command again. A tool that splits the command at `&&` before the shell reads it runs the commented step, here a delete. The file the first step wrote is still there, with the next line’s write after it.',
    'mkdir -p dist && echo kept > dist/out.txt # && rm dist/out.txt\necho next >> dist/out.txt',
    'kept\nnext\n',
  ),

  // vt_shell/src/lib.rs, the other side of a comment: `#` inside a word.
  shell(
    'command-hash-inside-a-word-is-text',
    'A `#` in the middle of a word, `a#b`, is text and not a comment',
    'Only a `#` that starts a word begins a comment. A tool that cuts the command at every `#` drops the rest of the word and everything after it. The program receives `a#b` and the step after it runs.',
    'mkdir -p dist && echo a#b > dist/out.txt && echo c >> dist/out.txt',
    'a#b\nc\n',
  ),

  // vt_shell/src/lib.rs: a single `&` is not half of `&&`.
  shell(
    'command-background-step-and-wait',
    'A single `&` runs a step in the background, and `wait` waits for it',
    'One `&` starts a job without waiting; `wait` then holds the command until it ends. A tool that reads `&` as a broken `&&`, or ends the task when its shell reaches the end, loses the job’s write. The file holds what the background job wrote.',
    'mkdir -p dist && (sleep 1; echo late > dist/out.txt) & wait',
    'late\n',
  ),

  // vt_shell/src/lib.rs falls back to the shell for compound commands.
  shell(
    'command-brace-group-one-redirect',
    'A `{ …; }` group sends every step’s output through one redirect',
    'Braces group steps without a subshell, so one `>` after them catches all their output. A tool that runs the steps one by one applies the redirect to the last only. The file holds both lines.',
    'mkdir -p dist && { echo a; echo b; } > dist/out.txt',
    'a\nb\n',
  ),

  // vt_shell/src/lib.rs falls back to the shell for compound commands.
  shell(
    'command-if-then-else',
    'An `if … then … else … fi` in a command takes the branch its test picks',
    'Conditionals are common in tasks: build only when a file exists, pick a flag by platform. A tool that splits at `;` runs `then` and `else` as programs. The branch for the true test runs.',
    'mkdir -p dist && if [ -f src/a.txt ]; then echo yes; else echo no; fi > dist/out.txt',
    'yes\n',
  ),

  // vt_shell/src/lib.rs: `exit` is a builtin that ends the whole command.
  shell(
    'command-exit-ends-the-command',
    'An `exit 0` in the middle of a command ends it there, successfully',
    '`exit` ends the shell, so nothing after it runs, and the status is the one it gives. A tool that runs each step in its own shell lets the steps after it run. The run succeeds and the later write never happens.',
    'mkdir -p dist && echo one > dist/out.txt && exit 0; echo two >> dist/out.txt',
    'one\n',
  ),

  // vt_shell/src/lib.rs: `$?` belongs to the shell running the whole line.
  shell(
    'command-status-variable-after-failure',
    'A step after a failure reads its status from `$?`',
    'In one shell, `$?` holds the status of the last command. A tool that runs the steps in separate processes, or under `set -e`, loses it or never reaches the next step. The file holds 1, the status of `false`.',
    'false; s=$?; mkdir -p dist && echo "$s" > dist/out.txt',
    '1\n',
  ),

  // vt_shell/src/lib.rs falls back to the shell for what it cannot parse.
  shell(
    'command-function-defined-and-called',
    'A shell function defined in a command can be called later in it',
    'A short function keeps a long task readable. A tool that splits the command into programs runs `greet()` as a program name. The call prints what the function says.',
    'greet() { echo "hi $1"; }; mkdir -p dist && greet you > dist/out.txt',
    'hi you\n',
  ),

  // vt_shell/src/lib.rs falls back to the shell for compound commands.
  shell(
    'command-case-statement',
    'A `case … esac` in a command takes the arm whose pattern matches',
    '`case` patterns use glob syntax and end each arm with `;;`. A tool that splits at `;` or expands the patterns against files breaks the statement. The `*.txt` arm runs.',
    'case a.txt in *.txt) r=text;; *) r=other;; esac; mkdir -p dist && echo "$r" > dist/out.txt',
    'text\n',
  ),

  // vt_shell/src/lib.rs: `$((…))` is an expansion the parser does not model.
  shell(
    'command-arithmetic-expansion',
    'An arithmetic expansion, `$((6*7))`, is replaced by its value',
    'Tasks compute counts and ports inline. The shell evaluates `$((…))`; a tool that passes the command on without a shell, or treats the `*` as a glob, writes the text or a file list. The file holds 42.',
    'mkdir -p dist && echo $((6*7)) > dist/out.txt',
    '42\n',
  ),

  // vt_shell/src/lib.rs, said of a glob that matches nothing.
  shell(
    'command-unmatched-glob-stays-literal',
    'An unquoted glob that matches no file reaches the program as written',
    'In `sh`, a pattern with no match is left as it is, unlike shells set to fail or to drop it. A tool that runs commands under such a shell either fails the task or passes no argument. The program receives `src/*.nomatch`.',
    'mkdir -p dist && echo src/*.nomatch > dist/out.txt',
    'src/*.nomatch\n',
  ),

  // vt_shell/src/lib.rs, said of input redirection.
  shell(
    'command-reads-stdin-from-a-file',
    'A `< file` redirect feeds the file to the program’s input',
    'A redirect is set up by the shell before the program starts. A tool that passes `<` as an argument hands the program a file named `<`. The program reads the source and writes it upper-cased.',
    'mkdir -p dist && tr a-z A-Z < src/a.txt > dist/out.txt',
    'A\n',
  ),

  // vt_shell/src/lib.rs test_flatten_pieces_recursion: `$VAR` is expanded,
  // so a quoted here-document delimiter must keep it as text.
  shell(
    'command-quoted-here-document-keeps-dollar',
    "A here-document with a quoted delimiter, `<<'EOF'`, keeps `$HOME` as text",
    'Quoting the delimiter turns off expansion inside the document, which is how a task writes a script or template holding `$`. A tool that rewrites the command, or expands variables itself, fills in the value. The file holds `$HOME` as typed.',
    "mkdir -p dist && cat > dist/out.txt <<'EOF'\n$HOME\nEOF\n",
    '$HOME\n',
  ),

  // vt_shell/src/lib.rs: the command is the shell’s script; what follows it
  // is not the user’s.
  shell(
    'command-sees-no-positional-args',
    'A command run with no forwarded args sees `$#` as 0',
    'A task that takes no args must not be handed any: no task name, no flag of the runner’s own. A tool that wraps the command and leaks words into its positional args changes what `"$@"` passes on. The count is 0.',
    'mkdir -p dist && echo "$#" > dist/out.txt',
    '0\n',
  ),

  // vt_shell/src/lib.rs: a trap belongs to the one shell running the line.
  shell(
    'command-exit-trap-runs',
    'An `EXIT` trap set at the start of a command runs when the command ends',
    'A trap is how a task cleans up or stamps a file whatever happens. It runs when the shell exits, after the last step. A tool that runs each step in its own process never runs it. The file holds the last step’s line, then the trap’s.',
    "trap 'echo bye >> dist/out.txt' EXIT; mkdir -p dist && echo hi > dist/out.txt",
    'hi\nbye\n',
  ),

  // vt_shell/src/lib.rs test_flatten_pieces_recursion: `""` is an empty arg.
  shell(
    'command-empty-quoted-arg-kept',
    'An empty quoted arg, `""`, reaches the program as an arg of its own',
    'Programs tell an empty value from no value: `--prefix ""` is not `--prefix`. A tool that unquotes and drops empty words shifts every arg after it. The program receives two args, the first empty.',
    'mkdir -p dist && printf \'[%s]\\n\' "" x > dist/out.txt',
    '[]\n[x]\n',
  ),

  // vt_shell/src/lib.rs, said of a stream duplicated into a pipe.
  shell(
    'command-error-stream-merged-into-pipe',
    'A `2>&1` sends the error stream down the pipe with the output',
    'Order matters: `2>&1 |` merges the error stream into what the next program reads. A tool that captures the error stream itself first leaves the pipe empty. The next program receives and changes the line written to the error stream.',
    'mkdir -p dist && { echo e >&2; } 2>&1 | tr e E > dist/out.txt',
    'E\n',
  ),

  // vt_shell/src/lib.rs, said of a backslash at the end of a line.
  shell(
    'command-line-continuation',
    'A backslash at the end of a line joins it to the next one',
    'Long commands are wrapped with `\\` at the line end, and the shell reads the two lines as one. A tool that splits the command into lines first runs `two` as a program of its own. The program receives both words.',
    'mkdir -p dist && echo one \\\n  two > dist/out.txt',
    'one two\n',
  ),

  // vt_shell/src/lib.rs, said of the blanks between words.
  shell(
    'command-tab-separates-words',
    'A tab between a program and its args separates them as a space does',
    'The shell splits words on blanks, tabs included. A tool that splits only on spaces runs a program whose name holds a tab. The program runs with its args.',
    "mkdir -p dist\t&&\tprintf\t'%s\\n'\ttabbed\t> dist/out.txt",
    'tabbed\n',
  ),

  // vt_shell/src/lib.rs, said of a command written as a block in a config.
  shell(
    'command-with-leading-blank-lines',
    'A command that starts with blank lines and indentation still runs',
    'A command copied from a block string often starts with a newline and spaces. The shell skips them. A tool that takes everything before the first space as the program name runs nothing. The output is written.',
    '\n\n    mkdir -p dist && echo ok > dist/out.txt\n\n',
    'ok\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: a prefix value is unquoted as one
  // word, operators inside it included.
  shell(
    'command-inline-value-holding-operators',
    "A prefix value in quotes holding `;` and `&&`, `X='a;b && c' prog`, reaches the program whole",
    'A tool that lifts prefixes out of the command must cut them where the shell does, not at the first operator character. Quoted, `;` and `&&` are part of the value. The program sees the whole value.',
    "mkdir -p dist && X='a;b && c' sh -c 'echo \"$X\"' > dist/out.txt",
    'a;b && c\n',
  ),

  // vt_shell/src/lib.rs try_parse_as_and_list: the parts of an `&&` chain are
  // pipelines.
  shell(
    'command-pipe-binds-tighter-than-and',
    'In `a | b && c || d`, the pipe is one step whose status the `&&` and `||` act on',
    'A pipeline is a single step of an `&&` list: its status is its last program’s. A tool that splits at `|` before `&&` hands `c` the wrong status. Here the search fails, so the fallback runs.',
    'mkdir -p dist && echo a | grep -q b && echo found > dist/out.txt || echo none > dist/out.txt',
    'none\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: each part of the chain keeps its
  // own redirects.
  shell(
    'command-redirect-applies-to-its-step',
    'A `>` on one step of an `&&` chain catches only that step’s output',
    'A redirect belongs to the program it follows. A tool that splits the chain and sends the whole task’s output to the file, or that moves the redirect, writes lines the user sent to the terminal. The file holds only the first step’s line.',
    'mkdir -p dist && echo one > dist/out.txt && echo two',
    'one\n',
  ),

  // vt_shell/src/lib.rs test_parse_command: a prefix value is not expanded
  // as a glob.
  shell(
    'command-glob-in-inline-value-not-expanded',
    'A prefix value holding a glob, `X=src/*.txt prog`, reaches the program as written',
    'The shell does not expand file names in an assignment. A tool that expands the value itself, or treats the prefix as an arg, hands the program a file list. The program sees `src/*.txt`.',
    'mkdir -p dist && X=src/*.txt sh -c \'echo "$X"\' > dist/out.txt',
    'src/*.txt\n',
  ),

  // vt_shell/src/lib.rs test_flatten_pieces_recursion: quoted pieces next to
  // each other form one word.
  shell(
    'command-quotes-joined-into-one-word',
    'Plain, double-quoted and single-quoted pieces with no space between them make one arg',
    'A word can be built from pieces quoted in different ways: `a"b c"\'d e\'` is the single word `ab cd e`. A tool that unquotes piece by piece and splits between them passes three args. The program receives one.',
    "mkdir -p dist && printf '[%s]\\n' a\"b c\"'d e' > dist/out.txt",
    '[ab cd e]\n',
  ),

  // fspy/tests/rust_std.rs hard_link_destination: a hard link's new name is a
  // write.
  sandboxCase({
    id: 'sandbox/hardlink-outside-outputs-fails',
    title:
      'An isolated task that hard-links an input to a name outside its outputs fails, and leaves no name',
    why: 'A hard link makes a new file name, which is a write to the folder it lands in. Made outside the outputs, it is never stored and a replay leaves it out. The sandbox judges the new name like any other write: the task fails and the name is not left.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: one(iso('mkdir -p dist && cat src/a.txt > dist/out.txt && ln src/a.txt copy.txt'), {
      'src/a.txt': 'a\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' } } },
      { check: { missing: [`${A}/copy.txt`] } },
    ],
  }),

  // fspy/tests/rust_std.rs rename_destination: a rename writes both of its
  // ends.
  sandboxCase({
    id: 'sandbox/move-input-into-outputs-fails',
    title:
      'An isolated task that moves an input into its outputs fails, and the input stays where it was',
    why: 'A move takes the file out of its folder, which changes the inputs as surely as deleting it. A sandbox that only checks where a rename lands lets a task eat its own sources. The task fails and the source is kept.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: one(iso('mkdir -p dist && mv src/a.txt dist/out.txt'), { 'src/a.txt': 'a\n' }),
    steps: [{ run: 'build', expect: { exit: 'fail', files: { [`${A}/src/a.txt`]: 'a\n' } } }],
  }),

  // fspy/tests/rust_std.rs read_in_subprocess: a read in a child process is
  // the task's read.
  sandboxCase({
    id: 'sandbox/undeclared-read-in-background-grandchild-fails',
    title:
      'An isolated task fails when a process it started in the background reads an undeclared file',
    why: 'What a task’s children and their children do is the task’s doing, backgrounded or not. A sandbox that watches only the first process misses a read two levels down. The task fails, so its output never comes to depend on a file nothing keys.',
    from: ['sandbox-grants.unsafe', 'sandbox-hidden-reads.unsafe'],
    workspace: one(iso("mkdir -p dist && sh -c '(cat notes.txt > dist/out.txt) & wait'"), {
      'src/a.txt': 'a\n',
      'notes.txt': 'secret\n',
    }),
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  // fspy/tests/rust_std.rs read_in_subprocess, said of a write.
  sandboxCase({
    id: 'sandbox/undeclared-write-in-background-grandchild-fails',
    title:
      'An isolated task fails when a process it started in the background writes outside its outputs',
    why: 'A write two processes down is still the task’s write. A sandbox that follows only the first process lets the file land, where no replay brings it back. The task fails and the file is not left.',
    from: ['sandbox-grants.unsafe', 'sandbox-misrooted-writes.unsafe'],
    workspace: one(
      iso("mkdir -p dist && echo a > dist/out.txt && sh -c '(echo x > stray.txt) & wait'"),
      { 'src/a.txt': 'a\n' },
    ),
    steps: [{ run: 'build', expect: { exit: 'fail' } }, { check: { missing: [`${A}/stray.txt`] } }],
  }),

  // fspy/tests/rust_std.rs readdir: listing a folder is an access to it.
  sandboxCase({
    id: 'sandbox/undeclared-dir-listing-fails',
    title: 'An isolated task that lists a project folder it never declared fails',
    why: 'Which files a folder holds is something a task can build on, such as a list of pages. A listing of a folder outside the inputs keys nothing, so adding a file there would replay a stale list. The task fails.',
    from: ['sandbox-grants.unsafe', 'sandbox-hidden-reads.unsafe'],
    workspace: one(iso('mkdir -p dist && ls docs > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'docs/one.md': '1\n',
      'docs/two.md': '2\n',
    }),
    steps: [{ run: 'build', expect: { exit: 'fail' } }],
  }),

  // fspy/tests/shebang.rs spawn_sh_shebang: running a script reads it, and its
  // interpreter.
  sandboxCase({
    id: 'sandbox/input-script-runs',
    title: 'An isolated task may run an executable script that is one of its inputs',
    why: 'A task often runs a script kept beside its sources. Running it reads the script and starts the interpreter its first line names, both of which the task may reach. The script runs and writes the output.',
    from: ['sandbox-grants.unsafe', 'sandbox-run-direct.unsafe'],
    workspace: one(iso('mkdir -p dist && ./src/gen.sh > dist/out.txt'), {
      'src/a.txt': 'a\n',
      'src/gen.sh': '#!/bin/sh\necho generated\n',
    }),
    steps: [
      { chmod: { [`${A}/src/gen.sh`]: 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [OUT]: 'generated\n' } } },
    ],
  }),

  // vt_workspace/src/package_filter.rs path_normalisation_dotdot_in_middle
  selectDir(
    'select-dir-dotdot-in-middle',
    'A directory selector `packages/x/../a` selects the project in `packages/a`',
    'A `..` in a path steps up a folder, wherever it sits. A tool that matches the text against project folders finds none and fails, or one that strips the `..` finds the wrong one. Only `a` runs.',
    [{ dir: 'packages/x/../a' }],
    ['a#build'],
  ),

  // vt_workspace/src/package_filter.rs path_normalisation_trailing_dot
  selectDir(
    'select-dir-trailing-dot',
    'A directory selector `packages/a/.` selects the project in `packages/a`',
    'A trailing `/.` names the folder itself, as completion in a shell often leaves it. A tool that matches the text literally finds no project there. Only `a` runs.',
    [{ dir: 'packages/a/.' }],
    ['a#build'],
  ),

  // vt_workspace/src/package_filter.rs dir_pattern_glob_star, from another
  // folder of projects.
  selectDir(
    'select-dir-glob-picks-one-folder',
    'A directory glob `apps/*` selects the projects under `apps` and none under `packages`',
    'A directory glob is anchored at the folder it names. A tool that matches only the last part, `*`, takes every project in the workspace. Only the project under `apps` runs.',
    [{ dir: 'apps/*' }],
    ['web#build'],
  ),

  // vt_glob/src/path.rs test_match_ignores_mixed_patterns: `!**/temp/keep/**`
  // takes back a folder at any depth.
  defineCase({
    id: 'inputs/negated-folder-at-any-depth',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A negation `!**/snap/**` takes back a folder of that name at the top and deep down',
    why: 'A leading `**` lets a negation reach the folder wherever it sits, top level included. A tool that needs at least one folder before `snap` keys the top one; one that anchors it keys the deep one. Edits under either replay, and an edit to a source beside them runs the task again.',
    from: ['inputs-resolution', 'brace-inputs'],
    workspace: one(
      {
        command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
        inputs: ['src/**', 'snap/**', '!**/snap/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'a\n', 'snap/x.txt': 'x\n', 'src/deep/snap/y.txt': 'y\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/snap/x.txt`]: 'x2\n', [`${A}/src/deep/snap/y.txt`]: 'y2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [OUT]: 'b\n' } } },
    ],
  }),
] satisfies Case[]
