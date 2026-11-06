# `src/ui/` — the UI kit

## Purpose

The only module that draws. Every line vx prints is built from its
components: a verb, the run screen and every plugin compose `Block`s and
hand them to `print`, say a line with `say`, or write bytes a program
reads with `data`. Nothing else writes to a stream, prints with
`console`, names a colour or emits an escape
(`tests/ui-only-output.unsafe.test.ts`). Design:
[`docs/design/ui-2026-11.md`](../design/ui-2026-11.md).

The screen looks like a TUI and is not one: panels stacked top to
bottom, written into the scrollback line by line. A panel is its title
rule `─ Title ───` and its lines, with no box. Nothing is hidden, cut,
scrolled or placed side by side. Any CI gets the same coloured panels
(only the live redraw is gone). A plain pipe gets the same layout off
colour, the bytes a test or `grep` reads.

## Files

- `theme.ts`: the tokens. `Style`, `Tone`, `SYMBOL`, `INDENT`, the hues,
  `paint`, `detectColors`, `dumbTerminal`, `barWidth`, `ruleWidth`.
- `components.ts`: inline tokens and blocks, the panel rule, `wrap`,
  `render`.
- `terminal.ts`: the streams. `print`, `say`, `data`, `transient`,
  `colorsOf`.
- `kit.ts`: what the façade exports as `ui` (components and streams, no
  live region).
- `live-region.ts`: the run's bottom region (`createOutputWriter`).
- `ansi.ts`: reading a task's own escapes (`hasEscape`, `leavesStyle`,
  `endStyle`, `STYLE_END`, `lastRedraw`).
- `terminal-signals.ts`, `links.ts`: tab progress, notifications and file
  links (`terminalSignals`, `terminalLinks`, `notifyEscape`,
  `progressEscape`, `PROGRESS_CLEAR`, `fileLocations`, `fileMemo`,
  `linkPaths`).
- `refusal.ts`: a refusal or warning as a notice (`refusalNotice`,
  `lineNotice`, `messageParts`, `sayNotice`, `sayLine`).
- `version-line.ts`: `vx --version`, imported alone (`printVersion`).

## Public surface

```ts
type Style = Tone | 'aborted' | 'notRun' | 'local' | 'remote' | 'heading' | 'term'
  | 'muted' | 'strong' | 'label' | 'border' | 'plain'
type Tone = 'ok' | 'warn' | 'error' | 'info'
type Inline = string | Token | readonly Inline[]
interface Block { readonly lines: (colors: ColorSupport) => string[] }
export interface ColorSupport {
  enabled: boolean
  readonly columns?: number | undefined // the terminal's width, read live
}

// inline tokens: a plain string in prose, fields or a table renders dim
id(text) place(text) path(text) cmd(text) strong(text) dim(text) tone(style, text, bold?)
inline(x, colors) width(x) idParts(hueSource, project, task, colors, opts)

// blocks
section(title, count?, ...blocks)  // a panel: ─ Title count ───, then its lines
status(tone, verb, headline)       // ✗ vx lock  lock not written
line(...items) gap()               // one line at the margin; a blank line
text(...items) why(line)           // indented facts; an indented dim line
fields(rows: FieldRow[])           // dim label column, values aligned
fix(action) next(command)          // dim label, bold value
report(title, rows)                // blank line, then a section of fields
table(columns: Column[], rows)     // header, aligned cells, right-aligned numbers
excerpt(title, body)               // a file shown whole
code(frame) notice(parts: NoticeParts) trace(lines)
bar(segments: Segment[], colors) gauge(filled, style, colors)

// a panel's rule, for a panel drawn a row at a time (the run's Tasks list)
panelTop(title, colors, count?, note?)
wrap(line, width): string[]        // never cuts; a colour carries across rows

render(blocks, colors): string     // blocks a blank line apart, trailing newline
print(stream: StreamName, ...blocks) say(tone, line, stream?) data(stream, bytes)
transient(line): () => void        // a line that stands while something runs
tagged(tone, line, colors) colorsOf(stream)
paint(style, text, colors, bold?) detectColors(stream?) dumbTerminal()

// live-region.ts: the run's bottom region, erased and redrawn around each write
createOutputWriter(stream, opts: OutputWriterOptions): OutputWriter  // with a Region, on a StatusStream
// terminal-signals.ts: TerminalSignals — tab progress (progressEscape, PROGRESS_CLEAR) and
// a finished-run notification (notifyEscape)

// report/plain-output.ts: `sink` with terminal escapes stripped from task
// output, for a pipe, CI or `NO_COLOR` (tasks run with `FORCE_COLOR`).
export function plainOutput(sink: Logger): Logger

// util/plain-text.ts: Bun.stripANSI, but an unterminated OSC, DCS, SOS, PM
// or APC ends at its line, not the input's end (plain output, kept logs).
export function stripEscapes(text: string): string

// links.ts: file links in failed output
// path-links.ts: the path pattern both share
export function linkPaths(text: string, dir: string, isFile: (abs: string) => boolean): string
export interface OutputLocation {
  file: string // absolute
  line?: number
  col?: number
}
// the existing files a text names, { file (absolute), line?, col? }, unique, first 50
export function fileLocations(
  text: string,
  dir: string,
  isFile: (abs: string) => boolean,
): OutputLocation[]
export function fileMemo(): (abs: string) => boolean

// src/ui/refusal.ts: every refusal and warning a verb prints, as one ui.notice
export function messageParts(message: string): RefusalParts // first sentence heads; later sentences and indented lines are facts; "(see `cmd`)" is why, "did you mean X?" the fix
export function refusalNotice(
  verb: string,
  message: string,
  parts?: RefusalParts,
  opts?: { headline?; cwd? },
): Block // parts, else a config refusal's frame, else messageParts
export function lineNotice(tone: Tone, line: string, verb?: string): Block // the verb read off a `vx X:` prefix
export function sayNotice(tone: Tone, verb: string, message: string): void // a message as a notice, on stderr
export function sayLine(tone: Tone, line: string, verb?: string): void // lineNotice, on stderr
```

## Rules

- Tones: `ok` ✓ green, `warn` ! yellow, `error` ✗ red, `info` › cyan.
  `id` paints a `project#task` in each half's own hue (`identityHue`),
  the `#` dim; the identity palette shares no hue with a status
  (`tests/framed-output.test.ts`). `place` paints where a task runs as
  `id` does; `local` is meta (dim).
- Five levels, one look each, brightest first (`Style` in `theme.ts`):
  1 outcome, a tone (its glyph and status word bold); 2 name, a title
  (violet bold), an id's hues, a command (bold); 3 value, the fact
  (slate-300); 4 meta, a label, unit, hint or count (dim); 5 chrome, a
  rule (quiet grey). A plain string takes the level of where it sits: a
  field's value or a sentence is a value. No line reads plain white.
- Text is printed with every control byte but a tab and a line break as
  `\xNN`: a notice quotes paths and names, and one holding `ESC ]0;`
  retitled the terminal. An inline carries no escape of its own.
- Content sits 2 spaces in; labels are one dim column at least 8 wide.
- A panel's rule is flush with the bars beside their labels (`ruleWidth`).
- Colours are decided at print time per stream, so a `Block` renders
  plain into a test with `{ enabled: false }`.
- Task output is never boxed: a failure's frame keeps its own rules, and
  the bytes the task wrote stay copyable.

## Colour detection

| Env                                                                                                                                        | Result                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `NO_COLOR=<non-empty>`                                                                                                                     | off — overrides `FORCE_COLOR`                                     |
| `FORCE_COLOR=0` / `false`                                                                                                                  | off, even on a TTY                                                |
| `FORCE_COLOR=<any other>` or `=`                                                                                                           | on                                                                |
| any CI: `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD`, `JENKINS_URL` or `TEAMCITY_VERSION` set, not `0`/`false` | on: a CI log looks like the terminal, though the output is a pipe |
| neither                                                                                                                                    | on iff `stream.isTTY === true` and `TERM` is not `dumb`           |

`0` and `false` are the convention's "off" (supports-color, chalk,
Node). `orchestrator.run()` passes `{ enabled: false }` when the caller
provides a custom `log`; when the default renderer's colours are off,
`run()` hands it task output through `plainOutput`
(`report/plain-output.ts`). Hues are truecolor (`Bun.color(…, 'ansi-16m')`),
memoized per hue.

## Tests

- `tests/ui.test.ts`: each component plain and coloured.
- `tests/ui-only-output.unsafe.test.ts`: nothing outside `src/ui` writes,
  prints, paints or escapes, in core and in every plugin that imports it.
- `tests/colors.test.ts`: `detectColors` precedence and `paint`.
- `tests/term-dumb.test.ts`: `TERM=dumb` gets no colour unless
  `FORCE_COLOR` asks, and no live region.
