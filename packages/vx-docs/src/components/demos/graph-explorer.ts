// `<vx-graph-explorer>`: enhances the static graph `GraphExplorer.astro`
// renders. It unhides one button per package and hides the table, which the
// buttons replace; choosing a package (its button, or any of its tasks in
// the drawing) recolours the drawing in the pictures' tones for the run a
// change to it starts: the tasks that run again (accent), the upstream
// tasks the cache restores (ok), and the rest muted. The live region says
// the same in words.
import type { Tone } from '../guide/diagram/diagram.js'
import { affectedBy, joinNames, neededBy, rerunBy } from './model/toy-monorepo.js'

const HINT = 'Pick a package to change.'

class GraphExplorer extends HTMLElement {
  #selected: string | undefined

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const pkg = (e.target as Element).closest<HTMLElement | SVGElement>(
        'button[data-pkg], [data-task]',
      )
      if (pkg !== null) this.#select(pkg.dataset['pkg']!)
    })
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#selected !== undefined) this.#select(undefined)
    })
  }

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.static')!.hidden = true
    this.#status().hidden = false
    this.#render()
  }

  #select(pkg: string | undefined) {
    // A second press on the chosen package clears it, like a toggle button.
    this.#selected = pkg === this.#selected ? undefined : pkg
    this.#render()
  }

  #render() {
    const pkg = this.#selected
    const rerun = pkg === undefined ? [] : rerunBy(pkg)
    const needed = pkg === undefined ? [] : neededBy(pkg)
    const inRun = (id: string) => rerun.includes(id) || needed.includes(id)
    const toneOf = (id: string): Tone =>
      pkg === undefined
        ? 'default'
        : rerun.includes(id)
          ? 'accent'
          : needed.includes(id)
            ? 'ok'
            : 'muted'
    for (const box of this.querySelectorAll<SVGElement>('[data-task]')) {
      box.setAttribute('class', `box ${toneOf(box.dataset['task']!)}`)
    }
    for (const arrow of this.querySelectorAll<SVGElement>('[data-from]')) {
      const on = rerun.includes(arrow.dataset['to']!) && inRun(arrow.dataset['from']!)
      const tone: Tone = pkg === undefined ? 'default' : on ? 'accent' : 'muted'
      arrow.setAttribute('class', `arrow ${tone}`)
      const path = arrow.querySelector('path')!
      path.setAttribute('marker-end', `url(#vx-dg-graph-explorer-${tone})`)
    }
    for (const button of this.querySelectorAll<HTMLButtonElement>('button[data-pkg]')) {
      button.setAttribute('aria-pressed', String(button.dataset['pkg'] === pkg))
    }
    this.#status().textContent = pkg === undefined ? HINT : describe(pkg, rerun, needed)
  }

  #status() {
    return this.querySelector<HTMLElement>('.status')!
  }
}

function describe(pkg: string, rerun: string[], needed: string[]): string {
  const runs = `${joinNames(affectedBy(pkg))}: build and test again (${rerun.length} tasks).`
  return needed.length === 0 ? runs : `${runs} From the cache: ${joinNames(needed)}.`
}

customElements.define('vx-graph-explorer', GraphExplorer)
