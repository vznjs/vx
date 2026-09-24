# The diagram kit

The Guide draws its pictures with these Astro components. Each one renders
SVG into the page at build time: no client script, no Mermaid, readable in
both themes and at any width. The Guide is read by people with no context,
so the kit draws few, large, simple shapes: text is 13 to 15px, nodes are
160 × 48, and a picture is about 600 units wide at most. Every one is rendered on the site at
`/internals/diagrams/` (`src/content/docs/internals/diagrams.mdx`), and
`tests/diagram-kit.test.ts` reads that built page.

Colours come only from the theme's tokens (`src/styles/theme.css`):
`--vx-accent`, `--vx-link`, `--vx-fg`, `--vx-muted`, `--vx-surface`,
`--vx-surface-2`, `--vx-border`, `--vx-danger`, `--vx-ok`, `--vx-warn`, and
the font `--vx-mono`. The kit's own styles use nothing else, and the test
holds that. A picture that needs a colour the variants do not give is a
reason to add a variant here, not to write a hex value in a chapter.

## A hand-drawn SVG

A picture the kit does not fit is drawn by hand, in the same frame: put the
`<svg>` (about 600 wide, `viewBox` set, text 14 to 16px, colours only from
the tokens above) in a `<figure class="vx-diagram" role="img"
aria-label="…">`, with a `<figcaption>` if it needs one. `.vx-diagram` is
styled globally in `theme.css`, so the kit's figures and a hand-drawn one
look the same, and `tests/guide.test.ts` counts either as the chapter's
one picture.

## Using the kit

Import from a chapter (`src/content/docs/guide/<slug>.mdx`):

```mdx
import TaskGraph from '../../../components/guide/diagram/TaskGraph.astro'
```

## Variants

`variant` on a node, a box or a bar is one of:

| Variant   | Reads as                                           |
| --------- | -------------------------------------------------- |
| `default` | a plain node                                       |
| `accent`  | the one the text is about (lime)                   |
| `danger`  | the one that failed or is wrong (red)              |
| `muted`   | skipped, cached, not involved                      |
| `dashed`  | not there yet: undeclared, hypothetical, remote    |

## `TaskGraph`

A graph of tasks on a grid. The default slot is the caption.

| Prop        | Type                                   | Meaning                                                                                  |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `nodes`     | `{ id, label, sub?, wave, col, variant? }[]` | `wave` is the row (0 at the top), `col` the place in it; `col: 0.5` centres a node between 0 and 1 |
| `edges`     | `{ from, to, label?, dashed? }[]`      | an arrow from node `from` to node `to`; an unknown id fails the build                    |
| `label`     | `string`, optional                     | the `aria-label`; by default the edges in words                                          |
| `direction` | `'down'` (default) or `'right'`        | `right` lays waves out left to right                                                     |
| `nodeWidth` | `number`, default 160                  | widen for long labels                                                                    |

```mdx
<TaskGraph
  nodes={[
    { id: 'utils', label: 'utils#build', wave: 0, col: 0.5 },
    { id: 'ui', label: 'ui#build', wave: 1, col: 0 },
    { id: 'api', label: 'api#build', wave: 1, col: 1 },
    { id: 'app', label: 'app#build', wave: 2, col: 0.5, variant: 'accent' },
  ]}
  edges={[
    { from: 'utils', to: 'ui' },
    { from: 'utils', to: 'api' },
    { from: 'ui', to: 'app' },
    { from: 'api', to: 'app' },
  ]}
>
  The caption.
</TaskGraph>
```

## `Timeline`

Workers over time, one lane per worker. The default slot is the caption.

| Prop    | Type                                                   | Meaning                                                  |
| ------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `lanes` | `{ name, bars: { start, end, label, variant? }[] }[]`  | a bar runs from `start` to `end`, in the axis's units    |
| `unit`  | `string`                                               | printed after each tick: `s`, `ms`, `' min'`             |
| `label` | `string`, optional                                     | the `aria-label`; by default every bar in words          |
| `width` | `number`, default 600                                  | the drawing's width before it scales to the column       |

A bar too short for its label drops the text and keeps it as a tooltip. On
a phone a timeline keeps 480 units of width and scrolls sideways in its
frame, so its text stays readable.

## `Diagram`, `Box` and `Arrow`

For a picture that is not a graph or a timeline. `Diagram` is the frame: a
`<figure>` holding one `<svg role="img">` whose `viewBox` is `width` ×
`height`, scaled down to the column. `Box` and `Arrow` draw inside it, in
the diagram's own units; put the caption in `slot="caption"`.

| Component | Props                                                                 |
| --------- | --------------------------------------------------------------------- |
| `Diagram` | `width`, `height`, `label` (the `aria-label`, required), `minWidth?` (the narrowest it renders; a narrower column scrolls it) |
| `Box`     | `x`, `y` (top-left), `w` = 160, `h` = 48, `label`, `sub?`, `variant?`  |
| `Arrow`   | `x1`, `y1`, `x2`, `y2` (head at the second point), `label?`, `dashed?`, `variant?` (`default`, `accent`, `danger`) |

```mdx
<Diagram width={320} height={80} label="utils, then ui.">
  <Box x={10} y={18} w={90} label="utils" />
  <Arrow x1={100} y1={40} x2={140} y2={40} label="then" />
  <Box x={140} y={18} w={90} label="ui" variant="accent" />
  <Fragment slot="caption">The caption.</Fragment>
</Diagram>
```

Put only `Box`, `Arrow` and the caption inside a `Diagram`: prose there
would land inside the `<svg>`.
