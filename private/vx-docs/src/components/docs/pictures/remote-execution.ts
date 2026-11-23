import type { Picture } from '../../guide/diagram/diagram.js'

export const remoteExecution: Picture = {
  name: 'remote-execution',
  label:
    'Your machine plans the run and sends each task to the REAPI server. The server queues it and stores files; a worker runs the command and sends the outputs back.',
  caption: 'Your machine plans; the pool runs the commands and keeps the files.',
  height: 200,
  frames: [{ x: 210, y: 20, w: 380, h: 160, label: 'your REAPI pool', tone: 'link' }],
  boxes: [
    {
      id: 'you',
      x: 10,
      y: 80,
      w: 150,
      label: 'your machine',
      sub: 'plans the order',
      tone: 'accent',
    },
    { id: 'server', x: 230, y: 80, w: 150, label: 'server', sub: 'queue · files' },
    { id: 'workers', x: 425, y: 80, w: 150, label: 'workers', sub: 'run commands', tone: 'ok' },
  ],
  arrows: [
    { from: 'you', to: 'server', label: 'task' },
    { from: 'server', to: 'workers', label: 'run' },
  ],
  notes: [{ x: 400, y: 168, text: 'outputs go back the same way', anchor: 'middle' }],
  narrow: {
    width: 340,
    height: 410,
    frames: [{ x: 10, y: 130, w: 320, h: 270, label: 'your REAPI pool', tone: 'link' }],
    boxes: [
      {
        id: 'you',
        x: 95,
        y: 10,
        w: 150,
        label: 'your machine',
        sub: 'plans the order',
        tone: 'accent',
      },
      { id: 'server', x: 95, y: 165, w: 150, label: 'server', sub: 'queue · files' },
      { id: 'workers', x: 95, y: 275, w: 150, label: 'workers', sub: 'run commands', tone: 'ok' },
    ],
    arrows: [
      { from: 'you', to: 'server', label: 'task' },
      { from: 'server', to: 'workers', label: 'run' },
    ],
    notes: [{ x: 170, y: 378, text: 'outputs go back the same way', anchor: 'middle' }],
  },
}
