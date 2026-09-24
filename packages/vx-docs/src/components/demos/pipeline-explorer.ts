// `<vx-pipeline-explorer>`: enhances the static explorer
// `PipelineExplorer.astro` renders. The strip's links become toggle
// buttons and the table goes; choosing a stage shows its section alone and
// says in the live region what a plugin decides there, the table's cell for
// it. Choosing it again, or Escape, shows every stage.
import { STAGES } from './model/pipeline.js'

const HINT = 'Every stage. Pick one above.'

class PipelineExplorer extends HTMLElement {
  #selected: string | undefined

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const link = (e.target as Element).closest<HTMLElement>('a[data-hook]')
      if (link === null) return
      e.preventDefault()
      this.#select(link.dataset['hook']!)
    })
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#selected !== undefined) return this.#select(this.#selected)
      // A link answers Enter; a button also answers Space.
      const link = (e.target as Element).closest<HTMLElement>('a[data-hook]')
      if (e.key === ' ' && link !== null) {
        e.preventDefault()
        this.#select(link.dataset['hook']!)
      }
    })
  }

  connectedCallback() {
    for (const link of this.#links()) {
      link.setAttribute('role', 'button')
      link.setAttribute('aria-controls', `vx-stage-${link.dataset['hook']}`)
    }
    this.querySelector<HTMLElement>('.status')!.hidden = false
    this.querySelector<HTMLElement>('.overview')!.hidden = true
    // Open on the first stage: thirteen sections at once is the page
    // without JavaScript, and the explorer exists to show one.
    this.#selected = STAGES[0]!.hook
    this.#render()
  }

  #links() {
    return this.querySelectorAll<HTMLElement>('a[data-hook]')
  }

  #select(hook: string) {
    this.#selected = hook === this.#selected ? undefined : hook
    this.#render()
  }

  #render() {
    const hook = this.#selected
    for (const link of this.#links()) {
      link.setAttribute('aria-pressed', String(link.dataset['hook'] === hook))
    }
    for (const section of this.querySelectorAll<HTMLElement>('section[data-hook]')) {
      section.hidden = hook !== undefined && section.dataset['hook'] !== hook
    }
    this.querySelector<HTMLElement>('.status')!.textContent =
      hook === undefined ? HINT : describe(hook)
  }
}

function describe(hook: string): string {
  return STAGES.find((s) => s.hook === hook)!.plugin
}

customElements.define('vx-pipeline-explorer', PipelineExplorer)
