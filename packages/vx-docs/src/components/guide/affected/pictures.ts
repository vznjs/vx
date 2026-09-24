// Chapter 7's pictures (guide/affected). tests/guide-affected.test.ts
// holds the rendered SVGs to these values and the values to the model.
import type { Picture } from '../sketch.js'

const pkg = (id: string, x: number, y: number, tone?: 'accent' | 'muted' | 'danger') => ({
  id,
  x,
  y,
  w: 100,
  label: id,
  ...(tone === undefined ? {} : { tone }),
})

export const everything: Picture = {
  name: 'everything',
  label:
    'A typo fix in README.md goes to CI, and CI builds and tests all four packages: utils, ui, api and app.',
  caption: 'A typo fix in the README. CI still builds and tests all four packages.',
  boxes: [
    { id: 'readme', x: 20, y: 104, w: 150, label: 'README.md', sub: 'typo fixed' },
    { id: 'ci', x: 220, y: 104, w: 90, label: 'CI' },
    { ...pkg('utils', 370, 40, 'danger'), sub: 'build + test' },
    { ...pkg('ui', 485, 40, 'danger'), sub: 'build + test' },
    { ...pkg('api', 370, 150, 'danger'), sub: 'build + test' },
    { ...pkg('app', 485, 150, 'danger'), sub: 'build + test' },
  ],
  arrows: [
    { from: 'readme', to: 'ci' },
    { from: 'ci', to: 'utils' },
    {
      from: 'ci',
      to: 'ui',
      via: [
        [340, 20],
        [535, 20],
      ],
    },
    { from: 'ci', to: 'api' },
    {
      from: 'ci',
      to: 'app',
      via: [
        [340, 240],
        [535, 240],
      ],
    },
  ],
  notes: [{ x: 478, y: 226, text: '8 tasks run', tone: 'danger' }],
}

export const owners: Picture = {
  name: 'owners',
  label:
    'The changed file packages/ui/src/button.tsx belongs to the ui package. The changed file README.md belongs to no package.',
  caption: 'Each changed file belongs to the package whose folder holds it.',
  boxes: [
    { id: 'button', x: 20, y: 40, w: 260, label: 'packages/ui/src/button.tsx', sub: 'changed' },
    { id: 'readme', x: 20, y: 160, w: 260, label: 'README.md', sub: 'changed' },
    { id: 'ui', x: 400, y: 40, w: 140, label: 'ui', tone: 'accent' },
    { id: 'none', x: 400, y: 160, w: 140, label: 'no package', tone: 'muted' },
  ],
  arrows: [
    { from: 'button', to: 'ui', label: 'is in', tone: 'accent' },
    { from: 'readme', to: 'none', label: 'is in' },
  ],
}

export const dependents: Picture = {
  name: 'dependents',
  label:
    'utils is used by ui and api; ui and api are used by app. A change to ui affects ui and app, and not utils or api.',
  caption: 'Change ui, and app must be checked too: app uses ui. utils and api cannot break.',
  boxes: [
    pkg('utils', 250, 16, 'muted'),
    { ...pkg('ui', 110, 104, 'accent'), sub: 'changed' },
    pkg('api', 390, 104, 'muted'),
    { ...pkg('app', 250, 192, 'accent'), sub: 'uses ui' },
  ],
  arrows: [
    { from: 'utils', to: 'ui', tone: 'muted' },
    { from: 'utils', to: 'api', tone: 'muted' },
    { from: 'ui', to: 'app', tone: 'accent' },
    { from: 'api', to: 'app', tone: 'muted' },
  ],
  notes: [{ x: 20, y: 24, text: 'arrow: "is used by"', anchor: 'start' }],
}

export const considerThenRun: Picture = {
  name: 'consider-then-run',
  label:
    'You edit packages/ui/README.md. All 4 packages narrow to the affected ui and app, and the cache then runs 0 tasks, because no task reads the README.',
  caption: 'Affected decides which packages to look at. The cache decides what actually runs.',
  boxes: [
    { id: 'all', x: 20, y: 100, w: 160, label: 'All packages', sub: '4' },
    { id: 'affected', x: 220, y: 100, w: 160, label: 'Affected', sub: 'ui, app', tone: 'accent' },
    { id: 'run', x: 420, y: 100, w: 160, label: 'Run', sub: '0 tasks', tone: 'ok' },
  ],
  arrows: [
    { from: 'all', to: 'affected', tone: 'accent' },
    { from: 'affected', to: 'run', tone: 'ok' },
  ],
  notes: [
    { x: 300, y: 40, text: 'You edit packages/ui/README.md', tone: 'mono' },
    { x: 300, y: 186, text: 'picks the packages', tone: 'accent' },
    { x: 500, y: 186, text: 'no task reads it: skip', tone: 'ok' },
  ],
}

export const invisible: Picture = {
  name: 'invisible',
  label:
    'Every build reads the root file tsconfig.base.json, but no task declares it. A change to it selects no package.',
  caption: 'Every build reads this file, but no task declares it. Changing it selects nothing.',
  boxes: [
    { id: 'base', x: 190, y: 20, w: 220, label: 'tsconfig.base.json', sub: 'changed' },
    pkg('ui', 70, 180),
    pkg('api', 250, 180),
    pkg('app', 430, 180),
  ],
  arrows: [
    { from: 'base', to: 'ui', tone: 'danger', dashed: true },
    { from: 'base', to: 'api', tone: 'danger', dashed: true },
    { from: 'base', to: 'app', tone: 'danger', dashed: true },
  ],
  notes: [
    { x: 445, y: 135, text: 'read, never declared', tone: 'danger', anchor: 'start' },
    { x: 300, y: 252, text: 'affected: nothing', tone: 'danger' },
  ],
}
