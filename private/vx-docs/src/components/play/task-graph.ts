// `<vx-task-graph>`: enhances `TaskGraph.astro`. "What runs first?" picks
// a task (a box) or a name across projects and numbers the waves it runs
// in; "What reruns?" edits a file and shows which tasks miss. Every redraw
// comes from `model/task-graph.ts`; this file only paints it.
import {
  CAPTION,
  EDITS,
  allOf,
  orderView,
  rerunView,
  storyGraph,
  type View,
} from './model/task-graph.js'

const graph = storyGraph()

class TaskGraph extends HTMLElement {
  #mode: 'order' | 'rerun' = 'order'
  #targets: string[] = []
  #edit: string = EDITS[0]

  connectedCallback() {
    this.#mode = this.dataset['mode'] === 'rerun' ? 'rerun' : 'order'
    this.#targets = [this.dataset['task']!]
    this.querySelector<HTMLElement>('.modes')!.hidden = false
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button')
      if (b === null) return
      const d = b.dataset
      if (d['mode'] !== undefined) this.#mode = d['mode'] === 'rerun' ? 'rerun' : 'order'
      if (d['task'] !== undefined) this.#targets = [d['task']]
      if (d['all'] !== undefined) this.#targets = allOf(d['all'])
      if (d['edit'] !== undefined) this.#edit = d['edit']
      this.#paint()
    })
    this.#paint()
  }

  #paint() {
    const order = this.#mode === 'order'
    const view: View = order ? orderView(graph, this.#targets) : rerunView(graph, this.#edit)
    const all = this.#targets.length > 1 ? this.#targets[0]!.split('#')[1] : undefined
    for (const b of this.querySelectorAll<HTMLButtonElement>('button')) {
      const d = b.dataset
      if (d['mode'] !== undefined) b.setAttribute('aria-pressed', String(d['mode'] === this.#mode))
      if (d['edit'] !== undefined) b.setAttribute('aria-pressed', String(d['edit'] === this.#edit))
      if (d['all'] !== undefined) b.setAttribute('aria-pressed', String(d['all'] === all))
      if (d['task'] !== undefined) {
        b.hidden = !order
        b.setAttribute('aria-pressed', String(all === undefined && this.#targets[0] === d['task']))
      }
    }
    this.querySelector<HTMLElement>('.picks')!.hidden = !order
    this.querySelector<HTMLElement>('.edits')!.hidden = order
    this.querySelector('.cmd')!.textContent = order
      ? `$ vx run ${all === undefined ? this.#targets[0] : `${all} --all`}`
      : `edited ${this.#edit}`
    for (const g of this.querySelectorAll<SVGGElement>('g[data-box]')) {
      const v = view.boxes.get(g.dataset['box']!)!
      g.setAttribute('class', `box ${v.tone}`)
      g.querySelector('.sub')!.textContent = v.sub
    }
    for (const g of this.querySelectorAll<SVGGElement>('g[data-edge]')) {
      const tone = view.arrows.get(g.dataset['edge']!)!
      const path = g.querySelector('path')!
      g.setAttribute('class', `arrow ${tone}`)
      path.setAttribute('marker-end', `url(#${path.dataset['marker']}${tone})`)
    }
    this.querySelector('.vx-say')!.textContent = view.sentence
    this.querySelector('.excerpt code')!.replaceChildren(
      ...view.lines.map((l) => {
        const s = document.createElement('span')
        if (l.tone !== undefined) s.className = `is-${l.tone}`
        s.textContent = `${l.text}\n`
        return s
      }),
    )
    this.closest('figure')!.querySelector('figcaption')!.textContent = CAPTION[this.#mode]
  }
}

customElements.define('vx-task-graph', TaskGraph)
