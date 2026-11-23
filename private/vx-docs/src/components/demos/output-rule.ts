// `<vx-output-rule>`: enhances `OutputRule.astro`. The reader toggles which
// declared outputs the command wrote; the line says whether the task passes.
import { outputsVerdict } from './model/task-fields.js'

class OutputRule extends HTMLElement {
  connectedCallback() {
    this.querySelector<HTMLElement>('.try')!.hidden = false
    this.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-path]')
      if (b === null) return
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
      this.#show()
    })
  }

  #show() {
    const buttons = [...this.querySelectorAll<HTMLButtonElement>('[data-path]')]
    const declared = buttons.map((b) => b.dataset['path']!)
    const wrote = new Set(
      buttons
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset['path']!),
    )
    const v = outputsVerdict(declared, wrote)
    const say = this.querySelector<HTMLElement>('.say')!
    say.className = `say vx-say ${v.ok ? 'is-ok' : 'is-danger'}`
    say.textContent = v.ok ? 'The task passes.' : `The task fails: ${v.why}.`
  }
}

customElements.define('vx-output-rule', OutputRule)
