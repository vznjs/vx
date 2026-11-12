// Styled text as data: what a module below the terminal hands up for `ui`
// to draw (a plugin footer's cells, a notice's tone). Naming a style is not
// drawing it; the hues and escapes stay in src/ui.

/**
 * A style every component and inline token draws with, by the level of
 * what it marks. Five levels, each one look, brightest first:
 *
 *   1 outcome   how a thing went: a tone (`ok` `warn` `error` `info`,
 *               `aborted`, `notRun`), its glyph and status word bold
 *   2 name      what it is about: a title (`heading`), an id's hues, a
 *               command or path to type (`strong`, `term`), where a
 *               cache answer came from (`local`, `remote`)
 *   3 value     the fact itself: a field's value, a table cell, a
 *               sentence (`value`, a soft light grey: no line of vx
 *               reads plain white)
 *   4 meta      what frames a fact: a label, a unit, a hint, a count
 *               (`muted`, `label`)
 *   5 chrome    rules and separators (`border`)
 *
 * A component picks the level; a plain string takes the level of where it
 * sits (a value in a field, meta in a title's count).
 */
export type Style =
  | 'ok'
  | 'warn'
  | 'error'
  | 'info'
  | 'aborted'
  | 'notRun'
  | 'local'
  | 'remote'
  | 'heading'
  | 'term'
  | 'value'
  | 'muted'
  | 'strong'
  | 'label'
  | 'border'
  | 'plain'

/** How a status went: the four a notice or a status line can be. */
export type Tone = 'ok' | 'warn' | 'error' | 'info'

/** A piece of text in a style. */
export interface Token {
  readonly style: Style | 'id'
  readonly text: string
  readonly bold?: boolean
}

/** Styled text inside a component: a plain string, a token, or a run of them. */
export type Inline = string | Token | readonly Inline[]
