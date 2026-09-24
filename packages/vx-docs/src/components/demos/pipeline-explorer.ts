// `<vx-pipeline-explorer>`: enhances the static explorer
// `PipelineExplorer.astro` renders. The strip's links become toggle
// buttons; choosing a stage shows its section alone, marks its table row,
// and says in the live region what a plugin decides there and which
// first-party plugins fill it. Choosing it again, or Escape, shows every
// stage, which is the page without JavaScript.
import { STAGES, filledBy } from './model/pipeline.js'

const HINT =
  'Showing every stage. Choose one in the pipeline above to see only its hook, its first-party plugins and an example.'

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
    for (const row of this.querySelectorAll<HTMLElement>('tr[data-hook]')) {
      row.classList.toggle('is-selected', row.dataset['hook'] === hook)
    }
    this.querySelector<HTMLElement>('.status')!.textContent =
      hook === undefined ? HINT : describe(hook)
  }
}

function describe(hook: string): string {
  const n = STAGES.findIndex((s) => s.hook === hook)
  const stage = STAGES[n]!
  const who =
    stage.firstParty.length === 0
      ? 'No first-party plugin fills it yet.'
      : `First-party: ${filledBy(stage)}.`
  return `${hook}, stage ${n + 1} of ${STAGES.length}. ${stage.plugin} ${who}`
}

customElements.define('vx-pipeline-explorer', PipelineExplorer)
