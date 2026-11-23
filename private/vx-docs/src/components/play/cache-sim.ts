// `<vx-cache-sim>`: enhances `CacheSim.astro`. The reader toggles changes to
// the story workspace and runs a task; the element shows each task's key,
// whether it hit, missed or was up to date, and the line `vx why` would say.
// It starts where the static render ends: two runs done, cache warm.
import {
  deleteWebDist,
  emptyState,
  resultsHtml,
  run,
  summary,
  terminalHtml,
  toggle,
  type ChangeId,
  type RunResult,
  type State,
  type TaskName,
} from './model/cache-sim.js'

class CacheSim extends HTMLElement {
  #state: State = emptyState()
  #task: TaskName = 'build'

  connectedCallback() {
    this.#task = this.dataset['task'] === 'test' ? 'test' : 'build'
    run(this.#state, this.#task)
    run(this.#state, this.#task)
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button')
      if (b === null) return
      const change = b.dataset['change'] as ChangeId | undefined
      if (change !== undefined) {
        toggle(this.#state, change)
        const on = this.#state.changed.has(change)
        b.setAttribute('aria-pressed', String(on))
        this.#say(`${b.textContent!.trim()}: ${on ? 'changed' : 'undone'}. Run to see what moves.`)
      } else if (b.hasAttribute('data-delete-dist')) {
        deleteWebDist(this.#state)
        this.#say('packages/web/dist/ is gone. Nothing else changed. Run to see what vx does.')
      } else if (b.dataset['task'] !== undefined) {
        this.#task = b.dataset['task'] as TaskName
        for (const t of this.querySelectorAll('[data-task]'))
          t.setAttribute('aria-pressed', String(t === b))
        this.querySelector('.go code')!.textContent = `vx run ${this.#task} --all`
      } else if (b.classList.contains('go')) {
        this.#show(run(this.#state, this.#task))
      } else if (b.classList.contains('reset')) {
        this.#state = emptyState()
        for (const c of this.querySelectorAll('[data-change]'))
          c.setAttribute('aria-pressed', 'false')
        this.querySelector('.out')!.replaceChildren()
        this.#say('Fresh clone: empty cache, no edits. Run to fill the cache.')
      }
    })
  }

  #say(text: string) {
    this.querySelector('.say')!.textContent = text
  }

  #show(r: RunResult) {
    // Every string the model puts in HTML is escaped there.
    this.querySelector('.out')!.innerHTML =
      `<section class="run"><h4>Run ${r.n}</h4><ol class="results">${resultsHtml(r)}</ol>` +
      `<pre tabindex="0" aria-label="Terminal: run ${r.n}">${terminalHtml(r)}</pre></section>`
    this.#say(summary(r))
  }
}

customElements.define('vx-cache-sim', CacheSim)
