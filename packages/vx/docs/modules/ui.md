# `src/util/ui.ts` — output components

## Purpose

vx's lines are UI, not a stream of text (2026-10-15). A verb or a
plugin composes components; each owns its color, indent and spacing, so
every surface shares one look. Design: `org/devex/log-design.md`. The
façade exports the set as `ui`, so a plugin draws with the same parts.

## Public surface

```ts
type Tone = 'ok' | 'warn' | 'error' | 'info'
type Inline = string | { style; text } | readonly Inline[]
interface Block { lines(colors: ColorSupport): string[] }

// inline tokens
id(text) place(text) path(text) cmd(text) dim(text) tone(t, text)

// blocks
status(tone, verb, headline)   // ✗ vx lock  lock not written
text(...lines)                 // indented facts
why(line)                      // indented dim line
fields(rows: FieldRow[])       // dim label column, values aligned
fix(action) next(command)      // dim label, bold value
report(mark, rows)             // blank line, brand rule, fields
table(columns, rows)           // dim header, aligned columns
code(frame)                    // a source frame, indented
notice({ tone, verb, headline, what?, why?, code?, fix? })

render(blocks, colors): string // blocks a blank line apart, trailing newline
print('out' | 'err', ...blocks)
```

## Rules

- Tones: `ok` ✓ green, `warn` ! yellow, `error` ✗ red, `info` › cyan.
  `id` paints a `project#task` as rows do: each half in its name's hue (`identityColor`), the `#` dim.
  `place` paints where a task runs (`small#1`) as `id` does; `local` stays plain.
- Text is printed with every control byte but a tab and a line break as
  `\xNN`: a notice quotes paths and names, and one holding `ESC ]0;`
  retitled the terminal. A component's colors are its own; an inline
  carries no escape.
- Content sits 2 spaces under a headline; labels are one dim column at
  least 8 wide; `fix` and `next` values are bold.
- Colors are decided at print time per stream (`detectColors`), so a
  `Block` renders plain into a test with `{ enabled: false }`.
- A refusal carries its parts (`UserError.parts`, built by `refusal()`);
  `vx lock` renders them as a `notice`, and a config error's
  `configRefusal()` adds the source frame and the fix. The flat
  `message` stays for `--format json` and logs.

## Tests

`tests/ui.test.ts`: each component plain and colored.
