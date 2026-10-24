// Motion on the site costs nothing once it ends. An endless animation, or
// one that animates a custom property, restyles every element that reads it
// on every frame, forever: the DTE post's lane charts did that to some 600
// SVG bars and iOS Safari killed the tab ("A problem repeatedly occurred",
// 2026-10-24). Every stylesheet the site ships, and every component's
// <style>, is held to it here.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')

const styleSources = (): Array<[string, string]> =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css') || f.endsWith('.astro'))
    .map((f) => [f, readFileSync(path.join(SRC, f), 'utf8')])

describe('motion budget', () => {
  it('finds the stylesheets', () => {
    expect(styleSources().map(([f]) => f)).toContain(path.join('styles', 'charts.css'))
  })

  it.each(styleSources())('%s runs no endless animation', (_, css) => {
    expect(css).not.toMatch(/animation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/)
  })

  it.each(styleSources())('%s animates no custom property', (_, css) => {
    const frames = [...css.matchAll(/@keyframes[^{]*\{((?:[^{}]*\{[^}]*\})*)[^{}]*\}/g)]
    for (const [, body] of frames) expect(body).not.toMatch(/(?:^|[{;\s])--[\w-]+\s*:/)
  })
})
