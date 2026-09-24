// `<vx-stale-hit>`: enhances the static table `StaleHit.astro` renders. It
// unhides the five step buttons and a live panel, and hides the table, which
// the buttons replay one run at a time. The panel shows the task's config,
// its key, what the run did, what `dist/out.txt` holds next to what it
// should be, and, when the run fails, the report vx prints.
import {
  STALE_STEPS,
  configSource,
  describeStaleRun,
  keyCellOf,
  outputOf,
  staleRuns,
  verdictOf,
} from './model/stale-hit.js'

const RUNS = staleRuns()

class StaleHit extends HTMLElement {
  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const step = (e.target as Element).closest<HTMLButtonElement>('button[data-step]')
      if (step !== null) this.#show(STALE_STEPS.findIndex((s) => s.id === step.dataset['step']))
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
    const r = RUNS[i]!
    for (const [j, b] of this.querySelectorAll<HTMLButtonElement>('button[data-step]').entries()) {
      b.setAttribute('aria-pressed', String(j === i))
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
    this.querySelector('.status')!.textContent = describeStaleRun(r)
  }
}

customElements.define('vx-stale-hit', StaleHit)
