import {
  changeAlphaToReachColorContrast,
  definePlugin,
  ensureColorContrastOnBackground,
  InlineStyleAnnotation,
} from '@astrojs/starlight/expressive-code'

// An ` ```ansi ` block paints vx's own 24-bit escapes as written, and
// Expressive Code lifts only a theme's own token colours to its minimum
// contrast: vx's pink and blue names, picked for a dark terminal, sat at
// 2.4:1 on the light theme's code. Each colour is lifted the way Expressive
// Code lifts a theme's (5.5:1, its default) against each theme's
// background; dimmed text (an alpha) only to 3.5:1, so it still recedes.
// tests/code-contrast.test.ts holds every built token to it.
const UNDERLINE_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[58;[0-9;]*m`, 'g')

export function ansiContrast() {
  return definePlugin({
    name: 'vx-ansi-contrast',
    hooks: {
      // Shiki's ansi parser knows no 58 (underline colour): it reads the 2
      // of `58;2;r;g;b` as dim and greyed vx's underlined section titles.
      // The page keeps the underline, in the text's own colour.
      preprocessCode({ codeBlock }) {
        if (codeBlock.language !== 'ansi') return
        for (const line of codeBlock.getLines()) {
          const spans = [...line.text.matchAll(UNDERLINE_COLOUR)].reverse()
          for (const m of spans) line.editText(m.index, m.index + m[0].length, '')
        }
      },
      postprocessAnalyzedCode({ codeBlock, styleVariants }) {
        if (codeBlock.language !== 'ansi') return
        for (const line of codeBlock.getLines()) {
          for (const a of line.getAnnotations()) {
            if (!(a instanceof InlineStyleAnnotation) || a.color === undefined) continue
            const bg = styleVariants[a.styleVariantIndex ?? 0]?.theme.bg
            if (bg === undefined) continue
            a.color = /^#[0-9a-f]{8}$/i.test(a.color)
              ? changeAlphaToReachColorContrast(a.color, bg, 3.5)
              : ensureColorContrastOnBackground(a.color, bg, 5.5)
          }
        }
      },
    },
  })
}
