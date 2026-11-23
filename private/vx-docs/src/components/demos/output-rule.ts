// `<vx-output-rule>`: enhances `OutputRule.astro`. A typed output path
// says whether vx requires it after the command or lets it match nothing.
import { outputRule } from './model/task-fields.js'

class OutputRule extends HTMLElement {
  connectedCallback() {
    this.querySelector<HTMLElement>('.try')!.hidden = false
    const say = this.querySelector<HTMLElement>('.say')!
    this.querySelector<HTMLInputElement>('.path')!.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value
      const r = outputRule(v)
      say.hidden = r === 'empty'
      say.className = `say vx-say ${r === 'required' ? 'is-warn' : 'is-ok'}`
      say.textContent =
        r === 'required'
          ? `${v.trim()} has no wildcard: it must exist, or the task fails.`
          : `${v.trim()} has a wildcard: it may match nothing.`
    })
  }
}

customElements.define('vx-output-rule', OutputRule)
