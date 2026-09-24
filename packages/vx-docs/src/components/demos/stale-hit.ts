// `<vx-stale-hit>`: enhances the static table `StaleHit.astro` renders. It
// unhides the step buttons, four toggles and a live panel, and hides the
// table, which the step buttons replay one run at a time. A toggle is one
// change followed by one run of the model. The panel shows the task's config,
// its key, what the run did, what `dist/out.txt` holds next to what a run
// with no cache writes, and, when the run fails, the report vx prints.
import {
  STALE_STEPS,
  applyStaleChange,
  configSource,
  describeStaleChange,
  describeStaleRun,
  keyCellOf,
  outputOf,
  staleRun,
  staleRuns,
  toggleOn,
  verdictOf,
  type StaleChange,
  type StaleRun,
} from './model/stale-hit.js'

const RUNS = staleRuns()

class StaleHit extends HTMLElement {
  #run: StaleRun = RUNS[0]!
  #step: number | undefined = 0
  #said = ''

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button')
      if (button === null) return
      const { step, toggle } = button.dataset
      if (step !== undefined) this.#show(STALE_STEPS.findIndex((s) => s.id === step))
      else if (toggle !== undefined) this.#change(toggle as StaleChange)
    })
  }

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.status')!.hidden = false
    this.querySelector<HTMLElement>('.live')!.hidden = false
    this.querySelector<HTMLElement>('.static')!.hidden = true
    this.#show(0)
  }

  #show(i: number) {
    this.#run = RUNS[i]!
    this.#step = i
    this.#said = `${i + 1}. ${STALE_STEPS[i]!.title}. ${describeStaleRun(this.#run)}`
    this.#render()
  }

  #change(change: StaleChange) {
    const said = describeStaleChange(change, this.#run.state)
    this.#run = staleRun(applyStaleChange(this.#run.state, change), this.#run)
    this.#step = undefined
    this.#said = `${said} ${describeStaleRun(this.#run)}`
    this.#render()
  }

  #render() {
    const r = this.#run
    for (const [j, b] of this.querySelectorAll<HTMLButtonElement>('button[data-step]').entries()) {
      b.setAttribute('aria-pressed', String(j === this.#step))
    }
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-toggle]')) {
      b.setAttribute('aria-pressed', String(toggleOn(r.state, b.dataset['toggle'] as StaleChange)))
    }
    const mark = r.stale ? 'stale' : r.verdict
    const set = (sel: string, text: string): void => {
      const el = this.querySelector<HTMLElement>(`.live ${sel}`)!
      el.textContent = text
      el.dataset['verdict'] = mark
    }
    set('.config', configSource(r.state))
    set('.key', keyCellOf(r))
    set('.verdict', verdictOf(r))
    set('.got', outputOf(r))
    set('.want', r.truth)
    this.querySelector<HTMLElement>('.live .report')!.hidden = r.verdict !== 'failed'
    this.querySelector('.status')!.textContent = this.#said
  }
}

customElements.define('vx-stale-hit', StaleHit)
