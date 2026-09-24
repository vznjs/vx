// Chapter 3's pictures (Guide, "Dependencies"): the order that fails and
// the one that works, the two rules, and a cycle. An arrow goes from the
// task that must finish first to the task that waits, as in the graph
// explorer. tests/guide-dependencies.test.ts holds every arrow to the graph
// vx plans for the chapter's config, and the cycle to the message vx prints.

import type { Picture } from '../diagram.js'

export const ORDER: Picture = {
  id: 'order',
  label: 'app#build alone fails: it cannot find ui. After ui#build, app#build builds.',
  boxes: [
    { id: 'app-alone', x: 20, y: 40, w: 170, label: 'app#build', sub: 'fails', variant: 'danger' },
    { id: 'ui#build', x: 20, y: 170, w: 170, label: 'ui#build', sub: 'builds' },
    { id: 'app#build', x: 330, y: 170, w: 170, label: 'app#build', sub: 'builds', variant: 'ok' },
  ],
  arrows: [{ from: 'ui#build', to: 'app#build', variant: 'ok' }],
  notes: [
    { x: 20, y: 28, text: 'wrong order', anchor: 'start' },
    { x: 210, y: 70, text: "Cannot find module 'ui'", anchor: 'start', variant: 'danger' },
    { x: 20, y: 158, text: 'right order', anchor: 'start' },
  ],
}

export const RULES: Picture = {
  id: 'rules',
  label:
    'Rule ^build: utils#build before ui#build, because ui uses utils. Rule build: ui#build before ui#test, in the same package.',
  boxes: [
    { id: 'utils#build', x: 20, y: 40, w: 150, label: 'utils#build' },
    { id: 'ui#build', x: 300, y: 40, w: 150, label: 'ui#build' },
    { id: 'ui#build/2', x: 20, y: 170, w: 150, label: 'ui#build' },
    { id: 'ui#test', x: 300, y: 170, w: 150, label: 'ui#test' },
  ],
  arrows: [
    { from: 'utils#build', to: 'ui#build', label: '^build', variant: 'accent' },
    { from: 'ui#build/2', to: 'ui#test', label: 'build', variant: 'accent' },
  ],
  notes: [
    { x: 470, y: 67, text: 'ui uses utils', anchor: 'start' },
    { x: 470, y: 197, text: 'same package', anchor: 'start' },
  ],
}

export const CYCLE: Picture = {
  id: 'cycle',
  label:
    'A loop: utils#build waits for app#build, app#build waits for api#build, api#build waits for utils#build. No task can go first.',
  boxes: [
    { id: 'utils#build', x: 225, y: 20, w: 150, label: 'utils#build', variant: 'danger' },
    { id: 'api#build', x: 40, y: 190, w: 150, label: 'api#build', variant: 'danger' },
    { id: 'app#build', x: 410, y: 190, w: 150, label: 'app#build', variant: 'danger' },
  ],
  arrows: [
    { from: 'app#build', to: 'utils#build', variant: 'danger' },
    { from: 'utils#build', to: 'api#build', variant: 'danger' },
    { from: 'api#build', to: 'app#build', variant: 'danger' },
  ],
  notes: [{ x: 300, y: 140, text: 'no task can go first', variant: 'danger' }],
}
