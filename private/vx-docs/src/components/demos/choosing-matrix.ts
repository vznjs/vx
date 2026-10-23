// `<vx-choosing-matrix>`: enhances the static tables `ChoosingMatrix.astro`
// renders. It unhides a box per need and, on every change, asks the model
// which choices decide the ticked needs: the others are hidden, each deciding
// choice says which needs it decides and why, its tools are marked as meeting
// them or not, and the live region names the tools that meet every need.
// Clear, or unticking every box, shows the page as it is without JavaScript.
import { CHOICES, TOOL_NAME, evaluate, joinNames, verdictSentences } from './model/choosing.js'

const HINT =
  'Tick the needs that matter to you. The second table keeps only the choices that decide them.'

class ChoosingMatrix extends HTMLElement {
  constructor() {
    super()
    this.addEventListener('change', (e) => {
      if ((e.target as Element).matches('input[type="checkbox"]')) this.#render()
    })
    this.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.clear') === null) return
      for (const box of this.#boxes()) box.checked = false
      this.#render()
    })
  }

  connectedCallback() {
    for (const el of this.querySelectorAll<HTMLElement>('.controls, .status, .js-only')) {
      el.hidden = false
    }
    this.#render(HINT)
  }

  #boxes(): HTMLInputElement[] {
    return [...this.querySelectorAll<HTMLInputElement>('.needs input[type="checkbox"]')]
  }

  #render(status?: string) {
    const ticked = this.#boxes()
      .filter((b) => b.checked)
      .map((b) => b.value)
    const v = evaluate(ticked)
    for (const row of this.querySelectorAll<HTMLElement>('tr[data-need]')) {
      row.classList.toggle('is-selected', ticked.includes(row.dataset['need']!))
    }
    for (const group of this.querySelectorAll<HTMLElement>('tbody[data-choice]')) {
      const id = group.dataset['choice']!
      const deciding = v.choices.includes(id)
      group.hidden = !deciding
      const on = v.needs.filter((n) => n.decidedBy.includes(id))
      const decides = group.querySelector<HTMLElement>('.decides')!
      decides.hidden = on.length === 0
      decides.querySelector('td')!.textContent = on
        .map((n) => {
          const fits = n.fits.map((t) => TOOL_NAME[t])
          return `Decides “${n.label}”: ${joinNames(fits)} ${fits.length === 1 ? 'meets' : 'meet'} it. ${n.why}`
        })
        .join(' ')
      for (const row of group.querySelectorAll<HTMLElement>('tr[data-tool]')) {
        const tool = row.dataset['tool']!
        const favoured = (v.favours[id] ?? []).some((t) => t === tool)
        row.classList.toggle('is-fit', on.length > 0 && favoured)
        row.classList.toggle('is-out', on.length > 0 && !favoured)
      }
    }
    const shown =
      v.needs.length === 0
        ? ''
        : ` The second table shows ${v.choices.length} of the ${CHOICES.length} choices.`
    this.querySelector('.status')!.textContent =
      status ?? `${verdictSentences(v).join(' ')}${shown}`
  }
}

customElements.define('vx-choosing-matrix', ChoosingMatrix)
