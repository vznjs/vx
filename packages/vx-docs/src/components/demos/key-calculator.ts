// `<vx-key-calculator>`: enhances the static tables `KeyCalculator.astro`
// renders. It unhides the input controls and a live table, and hides the four
// static tables, which the replay buttons reproduce. Each control is one
// change followed by one run of the model: the live table shows every task's
// key before and after that run and how the run treats the task, and the live
// region says the same in words.
import {
  TOY_ENV,
  TOY_SCENARIOS,
  TOY_START,
  applyChange,
  describeChange,
  describeRun,
  rowMarks,
  rowOf,
  toyRun,
  toyRuns,
  valueOf,
  type ToyChange,
  type ToyRun,
} from './model/toy-monorepo.js'

const START =
  'Every task has run once, so the cache holds an entry for each. Change an input and read what the next run does.'

class KeyCalculator extends HTMLElement {
  #last: ToyRun = toyRun(TOY_START)
  #said = START

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button')
      if (button === null) return
      const { edit, declare, scenario } = button.dataset
      if (edit !== undefined) this.#change({ kind: 'edit', input: edit })
      else if (declare !== undefined) this.#change({ kind: 'declare', input: declare })
      else if (scenario !== undefined) this.#replay(scenario)
      else if (button.classList.contains('reset')) this.#reset()
    })
  }

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.status')!.hidden = false
    this.querySelector<HTMLElement>('.live')!.hidden = false
    this.querySelector<HTMLElement>('.scenarios')!.hidden = true
    this.#render()
  }

  #change(change: ToyChange) {
    const said = describeChange(change, this.#last.state)
    this.#last = toyRun(applyChange(this.#last.state, change), this.#last)
    this.#said = `${said} ${describeRun(this.#last)}`
    this.#render()
  }

  #replay(id: string) {
    const s = TOY_SCENARIOS.find((x) => x.id === id)!
    this.#last = toyRuns(s.changes).at(-1)!
    this.#said = `${s.title}. ${describeRun(this.#last)}`
    this.#render()
  }

  #reset() {
    this.#last = toyRun(TOY_START)
    this.#said = START
    this.#render()
  }

  #render() {
    const { state, tasks } = this.#last
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-edit]')) {
      b.setAttribute('aria-pressed', String(state.changed.includes(b.dataset['edit']!)))
    }
    for (const b of this.querySelectorAll<HTMLButtonElement>('button[data-declare]')) {
      b.setAttribute('aria-pressed', String(!state.undeclared.includes(b.dataset['declare']!)))
    }
    this.querySelector('.env-value')!.textContent = valueOf(state, TOY_ENV)
    const head = [...this.querySelectorAll('.live thead th')].map((th) => th.textContent!)
    const rows = tasks.map((t) => {
      const tr = document.createElement('tr')
      const marks = rowMarks(t)
      tr.dataset['moved'] = marks.moved
      tr.dataset['outcome'] = marks.outcome
      for (const [i, cell] of rowOf(t).entries()) {
        const el = document.createElement(i === 0 ? 'th' : 'td')
        if (i === 0) el.setAttribute('scope', 'row')
        else el.dataset['label'] = head[i]!
        el.textContent = cell
        tr.append(el)
      }
      return tr
    })
    this.querySelector('.live tbody')!.replaceChildren(...rows)
    this.querySelector('.status')!.textContent = this.#said
  }
}

customElements.define('vx-key-calculator', KeyCalculator)
