// `<vx-depends-on>`: enhances `DependsOn.astro`. Each entry, picked or
// typed, lights the tasks `web#build` waits for, or says why vx refuses it.
import { waitsOn } from './model/task-fields.js'

class DependsOn extends HTMLElement {
  connectedCallback() {
    const entry = this.querySelector<HTMLInputElement>('.entry')!
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-entry]')
      if (b === null) return
      entry.value = b.dataset['entry']!
      this.#show(entry.value)
    })
    entry.addEventListener('input', () => this.#show(entry.value))
  }

  #show(value: string) {
    for (const b of this.querySelectorAll<HTMLButtonElement>('[data-entry]'))
      b.setAttribute('aria-pressed', String(b.dataset['entry'] === value.trim()))
    const r = waitsOn(value)
    const lit = new Set(r.ok ? r.tasks : [])
    for (const t of this.querySelectorAll<HTMLElement>('[data-task]')) {
      if (t.dataset['task'] === 'web#build') continue
      const on = lit.has(t.dataset['task']!)
      t.classList.toggle('lit', on)
      t.classList.toggle('is-ok', on)
      t.classList.toggle('is-muted', !on)
    }
    const say = this.querySelector<HTMLElement>('.say')!
    say.classList.toggle('is-danger', !r.ok)
    say.textContent = !r.ok
      ? r.why
      : r.tasks.length === 0
        ? 'Nothing matches: web#build starts at once.'
        : `web#build waits for ${r.tasks.join(', ')}.`
  }
}

customElements.define('vx-depends-on', DependsOn)
