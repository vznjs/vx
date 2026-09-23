// `<vx-affected-graph>`: enhances the static graph `AffectedGraph.astro`
// renders. Each node becomes a toggle button; pressing one highlights the
// package and everything that depends on it, and the live region says the
// same in words.
import { affectedBy, joinNames } from './model/toy-monorepo.js'

const HINT = 'Select a package to see what a change to it affects.'

class AffectedGraph extends HTMLElement {
  #selected: string | undefined

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const node = (e.target as Element).closest<SVGGElement>('[data-node]')
      if (node !== null) this.#toggle(node.dataset['node']!)
    })
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#selected !== undefined) {
        this.#selected = undefined
        this.#render()
        return
      }
      if (e.key !== 'Enter' && e.key !== ' ') return
      const node = (e.target as Element).closest<SVGGElement>('[data-node]')
      if (node === null) return
      // Space would otherwise scroll the page, as it does for any non-<button>.
      e.preventDefault()
      this.#toggle(node.dataset['node']!)
    })
  }

  connectedCallback() {
    // `img` makes its children presentational, which would hide the buttons
    // from assistive technology; the static render needs it, the enhanced
    // one does not.
    this.querySelector('svg')!.setAttribute('role', 'group')
    for (const node of this.#nodes()) {
      const id = node.dataset['node']!
      node.setAttribute('tabindex', '0')
      node.setAttribute('role', 'button')
      node.setAttribute('aria-label', `${id}#build: show what a change to ${id} affects`)
    }
    this.#status().hidden = false
    this.#render()
  }

  #toggle(id: string) {
    this.#selected = this.#selected === id ? undefined : id
    this.#render()
  }

  #render() {
    const selected = this.#selected
    const affected = selected === undefined ? [] : affectedBy(selected)
    for (const node of this.#nodes()) {
      const id = node.dataset['node']!
      node.classList.toggle('is-affected', affected.includes(id))
      node.classList.toggle('is-source', id === selected)
      node.setAttribute('aria-pressed', String(id === selected))
    }
    for (const edge of this.querySelectorAll<SVGElement>('[data-from]')) {
      const on = affected.includes(edge.dataset['from']!) && affected.includes(edge.dataset['to']!)
      edge.classList.toggle('is-affected', on)
    }
    this.#status().textContent =
      selected === undefined
        ? HINT
        : `A change to ${selected} affects ${affected.length} build ${affected.length === 1 ? 'task' : 'tasks'}: ${joinNames(affected.map((id) => `${id}#build`))}.`
  }

  #nodes() {
    return this.querySelectorAll<SVGGElement>('[data-node]')
  }

  #status() {
    return this.querySelector<HTMLElement>('.status')!
  }
}

customElements.define('vx-affected-graph', AffectedGraph)
