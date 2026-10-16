<!--
Title: Conventional Commits, `type(scope): what a user can now do` (`!` if breaking).

Write the body as a short blog post a vx user would read: it becomes this
change's section of the release post. Plain words, fewest words, no speed
multiples, never "best". Every command and output below is copied from a
real run of this branch.
-->

## <What a user can now do, in one line>

**Before:** <the problem as a user hit it: what they ran, what went wrong
or was missing. One short paragraph.>

```sh
$ <command>
<real output showing the problem>
```

**After:** <what vx does now, in the user's terms. Name every command,
flag, config key and env var exactly as the code spells them.>

```sh
$ <same command>
<real output from this branch>
```

<Optional: the config a user writes, importing from '@vzn/vx/config'.>

### How it works

<Two to five sentences on the mechanism, for a reader who wants the why.
Link the doc page that goes deeper.>

### Breaking changes

<`old` → `new` or "→ removed", one line each, matching the commit's
`BREAKING CHANGE:` footer word for word. "None" if none.>

### Proof

- Tests (each fails without this change): <file "name">
- Perf (run-path changes): interleaved A/B, min of N, base / new / A-A
- Docs updated: <pages>
