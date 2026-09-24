// `<vx-key-calculator>`: enhances the static table `KeyCalculator.astro`
// renders. It unhides the edit buttons and a live table and hides the
// static one, whose columns the buttons reproduce. Each button is one change
// followed by one run of the model: the live table shows every task's key
// (a key that moved in the pictures' accent) and whether the run runs or
// hits it, and the live region says the same in counts.
import {
  TOY_START,
  applyChange,
  describeChange,
  rowMarks,
  rowOf,
  runSummary,
  toyRun,
  type ToyChange,
  type ToyRun,
} from './model/toy-monorepo.js'

const START = 'First run: every task runs. Now edit a package.'

class KeyCalculator extends HTMLElement {
  #last: ToyRun = toyRun(TOY_START)
  #said = START

  constructor() {
    super()
    this.addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button')
      if (button === null) return
      const { edit } = button.dataset
      if (edit !== undefined) this.#change({ kind: 'edit', input: edit })
      else if (button.classList.contains('reset')) this.#reset()
    })
  }

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.status')!.hidden = false
    this.querySelector<HTMLElement>('.live')!.hidden = false
    this.querySelector<HTMLElement>('.static')!.hidden = true
    this.#render()
  }

  #change(change: ToyChange) {
    const said = describeChange(change, this.#last.state)
    this.#last = toyRun(applyChange(this.#last.state, change), this.#last)
    this.#said = `${said} ${runSummary(this.#last)}`
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
    const rows = tasks.map((t) => {
      const tr = document.createElement('tr')
      const marks = rowMarks(t)
      tr.dataset['moved'] = marks.moved
      tr.dataset['outcome'] = marks.outcome
      for (const [i, cell] of rowOf(t).entries()) {
        const el = document.createElement(i === 0 ? 'th' : 'td')
        if (i === 0) el.setAttribute('scope', 'row')
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
