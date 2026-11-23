// The Servers pages' pictures (docs/servers/*): which server each plugin
// talks to, the order a cache read walks branches, where a result sits in
// the bucket, and the history's loop around a run.

import type { Picture } from '../../guide/diagram/diagram.js'

export const serversMap: Picture = {
  name: 'servers-map',
  label:
    'A CI job carries its OIDC token to three servers: the cache server through vxCache(), the history server through vxHistory() and the DTE server through dte().',
  caption: 'One CI token, three servers. Use only the ones you need.',
  height: 260,
  boxes: [
    { id: 'job', x: 10, y: 100, w: 150, label: 'CI job', sub: 'OIDC token', tone: 'accent' },
    { id: 'cache', x: 420, y: 16, w: 170, label: 'cache server', sub: 'vxCache()', tone: 'link' },
    { id: 'history', x: 420, y: 100, w: 170, label: 'history server', sub: 'vxHistory()' },
    { id: 'dte', x: 420, y: 184, w: 170, label: 'DTE server', sub: 'dte()' },
  ],
  arrows: [
    { from: 'job', to: 'cache', label: 'results' },
    { from: 'job', to: 'history', label: 'timings' },
    { from: 'job', to: 'dte', label: 'tasks' },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'job', x: 95, y: 10, w: 150, label: 'CI job', sub: 'OIDC token', tone: 'accent' },
      { id: 'cache', x: 4, y: 130, w: 160, label: 'cache server', sub: 'vxCache()', tone: 'link' },
      { id: 'history', x: 176, y: 130, w: 160, label: 'history server', sub: 'vxHistory()' },
      { id: 'dte', x: 90, y: 230, w: 160, label: 'DTE server', sub: 'dte()' },
    ],
    arrows: [
      { from: 'job', to: 'cache', label: 'results' },
      { from: 'job', to: 'history', label: 'timings' },
      { from: 'job', to: 'dte', label: 'tasks' },
    ],
  },
}

export const cacheReadOrder: Picture = {
  name: 'cache-read-order',
  label:
    'Pull request 7, from feat-x into main, reads refs/pull/7/merge first, then feat-x, then main. It writes only refs/pull/7/merge.',
  caption: 'Pull request #7 reads three branches in order and writes only the first.',
  height: 120,
  boxes: [
    {
      id: 'merge',
      x: 10,
      y: 30,
      w: 190,
      label: 'refs/pull/7/merge',
      sub: 'reads, writes',
      tone: 'accent',
    },
    { id: 'feat', x: 260, y: 30, w: 130, label: 'feat-x', sub: 'reads' },
    { id: 'main', x: 450, y: 30, w: 130, label: 'main', sub: 'reads' },
  ],
  arrows: [
    { from: 'merge', to: 'feat', label: 'miss' },
    { from: 'feat', to: 'main', label: 'miss' },
  ],
  narrow: {
    width: 340,
    height: 280,
    boxes: [
      {
        id: 'merge',
        x: 75,
        y: 10,
        w: 190,
        label: 'refs/pull/7/merge',
        sub: 'reads, writes',
        tone: 'accent',
      },
      { id: 'feat', x: 105, y: 110, w: 130, label: 'feat-x', sub: 'reads' },
      { id: 'main', x: 105, y: 210, w: 130, label: 'main', sub: 'reads' },
    ],
    arrows: [
      { from: 'merge', to: 'feat', label: 'miss' },
      { from: 'feat', to: 'main', label: 'miss' },
    ],
  },
}

export const cacheBucketPath: Picture = {
  name: 'cache-bucket-path',
  label:
    'A result sits in the bucket under four folders: the hashed issuer, the hashed repository, the hashed branch, then the cache key.',
  caption: 'Where one result sits in the bucket. Only the key is not hashed.',
  height: 110,
  boxes: [
    { id: 'issuer', x: 10, y: 24, w: 130, label: 'issuer/', sub: 'hashed', tone: 'muted' },
    { id: 'repo', x: 160, y: 24, w: 130, label: 'repository/', sub: 'hashed', tone: 'muted' },
    { id: 'branch', x: 310, y: 24, w: 130, label: 'branch/', sub: 'hashed', tone: 'muted' },
    { id: 'key', x: 460, y: 24, w: 130, label: 'key', sub: 'the result', tone: 'accent' },
  ],
  arrows: [
    { from: 'issuer', to: 'repo' },
    { from: 'repo', to: 'branch' },
    { from: 'branch', to: 'key' },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'issuer', x: 105, y: 10, w: 130, label: 'issuer/', sub: 'hashed', tone: 'muted' },
      { id: 'repo', x: 105, y: 90, w: 130, label: 'repository/', sub: 'hashed', tone: 'muted' },
      { id: 'branch', x: 105, y: 170, w: 130, label: 'branch/', sub: 'hashed', tone: 'muted' },
      { id: 'key', x: 105, y: 250, w: 130, label: 'key', sub: 'the result', tone: 'accent' },
    ],
    arrows: [
      { from: 'issuer', to: 'repo' },
      { from: 'repo', to: 'branch' },
      { from: 'branch', to: 'key' },
    ],
  },
}

export const historyLoop: Picture = {
  name: 'history-loop',
  label:
    'When a CI run starts it asks the history server for last times. When it ends it sends the new times. The next run, on any runner, starts with them.',
  caption: 'Every run reads what earlier runs learned, then adds what it learned.',
  height: 120,
  boxes: [
    { id: 'start', x: 10, y: 30, w: 150, label: 'run starts', sub: 'orders tasks' },
    { id: 'server', x: 225, y: 30, w: 150, label: 'history server', tone: 'accent' },
    { id: 'end', x: 440, y: 30, w: 150, label: 'run ends', sub: 'measured' },
  ],
  arrows: [
    { from: 'server', to: 'start', label: 'last times' },
    { from: 'end', to: 'server', label: 'new times' },
  ],
  narrow: {
    width: 340,
    height: 290,
    boxes: [
      { id: 'start', x: 95, y: 10, w: 150, label: 'run starts', sub: 'orders tasks' },
      { id: 'server', x: 95, y: 120, w: 150, label: 'history server', tone: 'accent' },
      { id: 'end', x: 95, y: 220, w: 150, label: 'run ends', sub: 'measured' },
    ],
    arrows: [
      { from: 'server', to: 'start', label: 'last times' },
      { from: 'end', to: 'server', label: 'new times' },
    ],
  },
}
