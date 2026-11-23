import type { Picture } from '../../guide/diagram/diagram.js'

// What a sandboxed task sees: inside the workspace only its grants and the
// outputs of the tasks it depends on; outside it the machine is readable
// except credential stores, and the network is closed to all but its hosts.
export const sandboxWalls: Picture = {
  name: 'sandbox-walls',
  label:
    'A sandboxed task reads and writes only what allow grants in its project, and reads the outputs of tasks it depends on. Other projects are hidden. Outside the workspace, the machine is readable unless hermetic is set (then only allow.read), credential stores are denied, and only the hosts in allow.network are reachable.',
  caption: 'Green is open, red is closed. hermetic: true closes /usr too.',
  height: 290,
  frames: [
    { x: 10, y: 10, w: 380, h: 270, label: 'workspace' },
    { x: 400, y: 10, w: 190, h: 270, label: 'this machine' },
  ],
  boxes: [
    { id: 'task', x: 25, y: 125, w: 120, label: 'the task', tone: 'accent' },
    { id: 'own', x: 210, y: 40, w: 165, label: 'its project', sub: 'what you grant', tone: 'ok' },
    { id: 'deps', x: 210, y: 125, w: 165, label: 'upstream dist/', sub: 'read-only', tone: 'link' },
    { id: 'other', x: 210, y: 210, w: 165, label: 'other projects', sub: 'hidden', tone: 'muted' },
    { id: 'sys', x: 415, y: 40, w: 160, label: '/usr ~/.cache', sub: 'readable', tone: 'ok' },
    {
      id: 'creds',
      x: 415,
      y: 125,
      w: 160,
      label: '~/.ssh ~/.npmrc',
      sub: 'denied',
      tone: 'danger',
    },
    {
      id: 'net',
      x: 415,
      y: 210,
      w: 160,
      label: 'the internet',
      sub: 'allow.network only',
      tone: 'warn',
    },
  ],
  arrows: [
    { from: 'task', to: 'own', via: [[180, 70]] },
    { from: 'task', to: 'deps' },
    { from: 'task', to: 'other', dashed: true, tone: 'muted', via: [[180, 240]] },
  ],
  narrow: {
    width: 340,
    height: 520,
    frames: [
      { x: 0, y: 0, w: 340, h: 300, label: 'workspace' },
      { x: 0, y: 315, w: 340, h: 200, label: 'this machine' },
    ],
    boxes: [
      { id: 'task', x: 110, y: 30, w: 120, label: 'the task', tone: 'accent' },
      { id: 'own', x: 10, y: 130, w: 155, label: 'its project', sub: 'what you grant', tone: 'ok' },
      {
        id: 'deps',
        x: 175,
        y: 130,
        w: 155,
        label: 'upstream dist/',
        sub: 'read-only',
        tone: 'link',
      },
      { id: 'other', x: 90, y: 225, w: 160, label: 'other projects', sub: 'hidden', tone: 'muted' },
      { id: 'sys', x: 10, y: 345, w: 155, label: '/usr ~/.cache', sub: 'readable', tone: 'ok' },
      {
        id: 'creds',
        x: 175,
        y: 345,
        w: 155,
        label: '~/.ssh ~/.npmrc',
        sub: 'denied',
        tone: 'danger',
      },
      {
        id: 'net',
        x: 90,
        y: 435,
        w: 160,
        label: 'the internet',
        sub: 'allow.network only',
        tone: 'warn',
      },
    ],
    arrows: [
      { from: 'task', to: 'own' },
      { from: 'task', to: 'deps' },
      { from: 'task', to: 'other', dashed: true, tone: 'muted' },
    ],
  },
}
