// `<vx-graph-explorer>`: enhances the static graph `GraphExplorer.astro`
// renders. It unhides one button per package; choosing a package (its button,
// or any of its tasks in the diagram) lights up the run a change to it starts:
// the tasks `--affected` selects, the upstream tasks the cache restores, and
// the rest dimmed. The live region says the same in words, with the order.
import { joinNames, neededBy, orderSentence, rerunBy } from './model/toy-monorepo.js'

const HINT =
  'Choose a package to change. The tasks that rerun light up, the ones the cache restores are dashed, and the rest fade.'

class GraphExplorer extends HTMLElement {
  #selected: string | undefined

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const target = e.target as Element
      if (target.closest('.clear') !== null) return this.#select(undefined)
      const pkg = target.closest<HTMLElement | SVGElement>('button[data-pkg], [data-task]')
      if (pkg !== null) this.#select(pkg.dataset['pkg']!)
    })
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#selected !== undefined) this.#select(undefined)
    })
  }

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
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
    for (const node of this.querySelectorAll<SVGElement>('[data-task]')) {
      const id = node.dataset['task']!
      node.classList.toggle('is-rerun', rerun.includes(id))
      node.classList.toggle('is-needed', needed.includes(id))
      node.classList.toggle('is-idle', pkg !== undefined && !inRun(id))
    }
    for (const edge of this.querySelectorAll<SVGElement>('[data-from]')) {
      const from = edge.dataset['from']!
      const to = edge.dataset['to']!
      edge.classList.toggle('is-on', rerun.includes(to) && inRun(from))
      edge.classList.toggle('is-idle', pkg !== undefined && !(rerun.includes(to) && inRun(from)))
    }
    for (const button of this.querySelectorAll<HTMLButtonElement>('button[data-pkg]')) {
      button.setAttribute('aria-pressed', String(button.dataset['pkg'] === pkg))
    }
    for (const row of this.querySelectorAll<HTMLElement>('tr[data-pkg]')) {
      row.classList.toggle('is-selected', row.dataset['pkg'] === pkg)
    }
    this.querySelector<HTMLButtonElement>('.clear')!.disabled = pkg === undefined
    this.#status().textContent = pkg === undefined ? HINT : describe(pkg, rerun, needed)
  }

  #status() {
    return this.querySelector<HTMLElement>('.status')!
  }
}

function describe(pkg: string, rerun: string[], needed: string[]): string {
  const runs = `You changed ${pkg}. vx run build test --affected runs ${rerun.length} tasks: ${joinNames(rerun)}, in this order: ${orderSentence(rerun)}.`
  if (needed.length === 0) return runs
  const them = needed.length === 1 ? 'it' : 'them'
  return `${runs} They need ${joinNames(needed)} first. Nothing changed there, so a cache from an earlier run restores ${them} instead of running ${them}.`
}

customElements.define('vx-graph-explorer', GraphExplorer)
