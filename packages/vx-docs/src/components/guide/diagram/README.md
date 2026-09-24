# The diagram kit

Every picture in the Guide is one component, `Diagram.astro`, drawing one
value of `Picture` (`diagram.ts`). It renders SVG into the page at build
time: no client script, no Mermaid, readable in both themes and at any
width. The look is one stylesheet, `diagram.css`: the landing's mono
(`--vx-mono`) for every label in the drawing, the body's sans for the
caption, 8-unit box corners, 1.5 and 2.5 strokes, and the theme's `--vx-*`
tokens only. `tests/diagram-kit.test.ts` holds that, and every chapter
picture's text to fit its box and the drawing. Each part is rendered on the
site at `/internals/diagrams/` (`src/content/docs/internals/diagrams.mdx`).

## A chapter's pictures

A chapter keeps its pictures as data in
`src/components/guide/<chapter>/pictures.ts`, so its rows
(`tests/guide-<chapter>.test.ts`) read the same values the page draws:

```mdx
import Diagram from '../../../components/guide/diagram/Diagram.astro'
import * as P from '../../../components/guide/why/pictures.js'

<Diagram {...P.packages} />
```

A picture drawn from a widget's model (the scheduler simulator, the toy
monorepo) computes its data from that model in `pictures.ts`, never by hand.

## `Picture`

| Field           | Meaning                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `name`          | unique on its page; the figure's `data-picture` and the arrowheads' ids         |
| `label`         | the `aria-label`: what the picture says, for a reader who cannot see it         |
| `caption`       | one short sentence under the drawing                                            |
| `width`, `height` | the canvas, default 600 × 260; the viewBox keeps the width and crops to what is drawn, so every picture shares one scale |
| `boxes`         | `{ id, x, y, w?, h?, label, sub?, tone?, title?, data? }`; `w` × `h` default 130 × 52 (60 high with a `sub`); `data` becomes `data-*` attributes |
| `arrows`        | `{ from, to, label?, tone?, dashed?, via? }`; `via` lists corners to pass       |
| `notes`         | `{ x, y, text, tone?, anchor? }`; loose text, muted by default                  |
| `frames`        | `{ x, y, w, h, label, tone? }`; a dashed group, titled at its top left          |
| `narrow`        | the phone layout: `{ width, height?, boxes, arrows?, notes?, frames? }`, at most `NARROW` (360) across |

`lanes(rows, at)` turns workers and their bars into boxes and notes (a
timeline); a bar too narrow for its label prints none and keeps its
`title`. With `down: true` time runs down the page, one column per lane:
the shape a timeline takes on a phone.

## Tones

| Tone      | Reads as                                   |
| --------- | ------------------------------------------ |
| `default` | a plain box or arrow                       |
| `accent`  | the one the text is about (lime)           |
| `ok`      | a result that is right                     |
| `danger`  | a result that is wrong, or a failure       |
| `warn`    | a miss, a warning                          |
| `link`    | a read, a boundary (cyan)                  |
| `muted`   | skipped, absent, not involved (dashed)     |

A picture that needs a look the tones do not give is a reason to add a
tone here, not to write a colour in a chapter.

## On a phone

A 600-wide drawing shrunk to a phone's column sets its type at about eight
pixels, and a cropped one that scrolls sideways hides boxes a reader does
not know to look for. So every picture wider than `NARROW` carries a
`narrow` layout: the same boxes, arrows, frames and words (a note may break
across lines; a lone arrow glyph points the way its layout runs), placed
to fit about 340 across. `Diagram.astro` draws both and `diagram.css`
shows the phone one below 32rem, where it draws at about full size.
`tests/diagram-kit.test.ts` holds that each picture has one, that it fits,
and that it says what the wide one says.

## Widgets

`Diagram.astro` is `DiagramSvg.astro` (the drawing) in a figure with its
caption. A widget that draws with the kit, the graph explorer, puts
`<DiagramSvg {...picture} live />` inside a `<div class="vx-diagram inset">`:
`inset` drops the picture's own frame, since the widget sits in the same
frame already, and `live` defines an arrowhead for every tone, so the
widget's element can change a box's or an arrow's tone class. A box's
`data` names what the element finds it by.

Every widget takes this look through `demos/widget.css`: the same frame and
caption, mono for what a reader acts on or reads as data, sans for
sentences, the 8-unit corner, the two strokes and these tones.
`tests/diagram-kit.test.ts` holds the widgets to the same tokens.

A widget that draws its own SVG keeps the phone rule too. The scheduler
simulator's `ganttSvg` draws each chart twice, `data-layout="wide"` with
time across and `data-layout="narrow"` with time down the page, one
column per worker, 340 across; its stylesheet swaps them at this kit's
32rem, and `tests/guide-concurrency.test.ts` holds the phone chart to the
wide one's bars, lines and words.
