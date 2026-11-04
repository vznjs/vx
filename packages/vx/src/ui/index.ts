// Module contract: vx's UI kit. The only module that draws: its tokens
// (theme), its components, the live region and the streams. Every other
// module and every plugin composes these (tests/ui-only-output.unsafe.test.ts).
// Design: docs/design/ui-2026-11.md.

export {
  bar,
  barWidth,
  cmd,
  code,
  dim,
  excerpt,
  fields,
  fix,
  gauge,
  id,
  idParts,
  inline,
  next,
  notice,
  panelBottom,
  panelRow,
  panelTop,
  path,
  place,
  render,
  report,
  section,
  status,
  strong,
  table,
  tagged,
  text,
  line,
  gap,
  tone,
  trace,
  why,
  width,
  wrap,
  type Block,
  type Column,
  type FieldRow,
  type Inline,
  type NoticeParts,
  type Segment,
} from './components.js'
export {
  detectColors,
  dumbTerminal,
  INDENT,
  paint,
  ruleWidth,
  SYMBOL,
  type ColorSupport,
  type Style,
  type Tone,
} from './theme.js'
export { colorsOf, data, print, say, transient, type StreamName } from './terminal.js'
export { endStyle, hasEscape, lastRedraw, leavesStyle, STYLE_END } from './ansi.js'
export {
  createOutputWriter,
  type OutputWriter,
  type OutputWriterOptions,
  type Region,
  type StatusStream,
} from './live-region.js'
export {
  notifyEscape,
  PROGRESS_CLEAR,
  progressEscape,
  terminalLinks,
  terminalSignals,
  type TerminalSignals,
} from './terminal-signals.js'
export { fileLocations, fileMemo, linkPaths, type OutputLocation } from './links.js'
export { lineNotice, messageParts, refusalNotice, sayLine, sayNotice } from './refusal.js'
