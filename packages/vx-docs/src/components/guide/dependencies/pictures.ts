// Chapter 3's pictures (Guide, "Dependencies"): the order that fails and
// the one that works, the two rules, and a cycle. An arrow goes from the
// task that must finish first to the task that waits, as in the graph
// explorer. tests/guide-dependencies.test.ts holds every arrow to the graph
// vx plans for the chapter's config, and the cycle to the message vx prints.

import type { Picture } from '../diagram/diagram.js'

export const order: Picture = {
  name: 'order',
  label: 'app#build alone fails: it cannot find ui. After ui#build, app#build builds.',
  caption: 'Same two tasks, different order.',
  boxes: [
    { id: 'app-alone', x: 20, y: 40, w: 170, label: 'app#build', sub: 'fails', tone: 'danger' },
    { id: 'ui#build', x: 20, y: 170, w: 170, label: 'ui#build', sub: 'builds' },
    { id: 'app#build', x: 330, y: 170, w: 170, label: 'app#build', sub: 'builds', tone: 'ok' },
  ],
  arrows: [{ from: 'ui#build', to: 'app#build', tone: 'ok' }],
  notes: [
    { x: 20, y: 28, text: 'wrong order', anchor: 'start' },
    { x: 210, y: 70, text: "Cannot find module 'ui'", anchor: 'start', tone: 'danger' },
    { x: 20, y: 158, text: 'right order', anchor: 'start' },
  ],
  narrow: {
    width: 340,
    height: 262,
    boxes: [
      { id: 'app-alone', x: 12, y: 36, w: 150, label: 'app#build', sub: 'fails', tone: 'danger' },
      { id: 'ui#build', x: 12, y: 182, w: 130, label: 'ui#build', sub: 'builds' },
      { id: 'app#build', x: 198, y: 182, w: 130, label: 'app#build', sub: 'builds', tone: 'ok' },
    ],
    arrows: [{ from: 'ui#build', to: 'app#build', tone: 'ok' }],
    notes: [
      { x: 12, y: 24, text: 'wrong order', anchor: 'start' },
      { x: 12, y: 120, text: "Cannot find module 'ui'", anchor: 'start', tone: 'danger' },
      { x: 12, y: 170, text: 'right order', anchor: 'start' },
    ],
  },
}

export const rules: Picture = {
  name: 'rules',
  label:
    'Rule ^build: utils#build before ui#build, because ui uses utils. Rule build: ui#build before ui#test, in the same package.',
  caption: 'An arrow means "must finish first".',
  boxes: [
    { id: 'utils#build', x: 20, y: 40, w: 150, label: 'utils#build' },
    { id: 'ui#build', x: 300, y: 40, w: 150, label: 'ui#build' },
    { id: 'ui#build/2', x: 20, y: 170, w: 150, label: 'ui#build' },
    { id: 'ui#test', x: 300, y: 170, w: 150, label: 'ui#test' },
  ],
  arrows: [
    { from: 'utils#build', to: 'ui#build', label: '^build', tone: 'accent' },
    { from: 'ui#build/2', to: 'ui#test', label: 'build', tone: 'accent' },
  ],
  notes: [
    { x: 470, y: 67, text: 'ui uses utils', anchor: 'start' },
    { x: 470, y: 197, text: 'same package', anchor: 'start' },
  ],
  narrow: {
    width: 340,
    height: 226,
    boxes: [
      { id: 'utils#build', x: 12, y: 20, w: 120, label: 'utils#build' },
      { id: 'ui#build', x: 208, y: 20, w: 120, label: 'ui#build' },
      { id: 'ui#build/2', x: 12, y: 130, w: 120, label: 'ui#build' },
      { id: 'ui#test', x: 208, y: 130, w: 120, label: 'ui#test' },
    ],
    arrows: [
      { from: 'utils#build', to: 'ui#build', label: '^build', tone: 'accent' },
      { from: 'ui#build/2', to: 'ui#test', label: 'build', tone: 'accent' },
    ],
    notes: [
      { x: 170, y: 98, text: 'ui uses utils' },
      { x: 170, y: 208, text: 'same package' },
    ],
  },
}

export const cycle: Picture = {
  name: 'cycle',
  label:
    'A loop: utils#build waits for app#build, app#build waits for api#build, api#build waits for utils#build. No task can go first.',
  caption: 'Every task waits for another.',
  boxes: [
    { id: 'utils#build', x: 225, y: 20, w: 150, label: 'utils#build', tone: 'danger' },
    { id: 'api#build', x: 40, y: 190, w: 150, label: 'api#build', tone: 'danger' },
    { id: 'app#build', x: 410, y: 190, w: 150, label: 'app#build', tone: 'danger' },
  ],
  arrows: [
    { from: 'app#build', to: 'utils#build', tone: 'danger' },
    { from: 'utils#build', to: 'api#build', tone: 'danger' },
    { from: 'api#build', to: 'app#build', tone: 'danger' },
  ],
  notes: [{ x: 300, y: 165, text: 'no task can go first', tone: 'danger' }],
  narrow: {
    width: 340,
    height: 256,
    boxes: [
      { id: 'utils#build', x: 105, y: 20, w: 130, label: 'utils#build', tone: 'danger' },
      { id: 'api#build', x: 12, y: 150, w: 130, label: 'api#build', tone: 'danger' },
      { id: 'app#build', x: 198, y: 150, w: 130, label: 'app#build', tone: 'danger' },
    ],
    arrows: [
      { from: 'app#build', to: 'utils#build', tone: 'danger' },
      { from: 'utils#build', to: 'api#build', tone: 'danger' },
      { from: 'api#build', to: 'app#build', tone: 'danger' },
    ],
    notes: [{ x: 170, y: 236, text: 'no task can go first', tone: 'danger' }],
  },
}
