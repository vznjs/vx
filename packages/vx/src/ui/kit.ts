// The kit a plugin draws with, exported by the façade as `ui`: the
// components and the streams, never the live region or the escapes that
// drive it (those are core's run screen). Same parts core's verbs use.

export {
  cmd,
  code,
  dim,
  excerpt,
  fields,
  fix,
  gap,
  id,
  inline,
  line,
  next,
  notice,
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
  tone,
  why,
  type Block,
  type Column,
  type FieldRow,
  type Inline,
  type NoticeParts,
} from './components.js'
export { type ColorSupport, type Style, type Tone } from './theme.js'
export { colorsOf, data, print, say, transient, type StreamName } from './terminal.js'
