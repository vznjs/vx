// `<vx-glob-tester>`: enhances `GlobTester.astro`. The reader edits a task's
// globs (and, for outputs, what the build wrote); the element re-renders the
// pattern list, the lit file tree, vx's printed lines and the sentence.
import { parsePatterns, render, type Mode } from './model/glob-tester.js'

class GlobTester extends HTMLElement {
  #written = new Set<string>()

  connectedCallback() {
    const area = this.#area()
    area.readOnly = false
    for (const el of this.querySelectorAll<HTMLElement>('[data-js]')) el.hidden = false
    for (const box of this.querySelectorAll<HTMLInputElement>('input[data-file]'))
      if (box.checked) this.#written.add(box.dataset['file']!)
    area.addEventListener('input', () => this.#show())
    this.addEventListener('click', (e) => {
      const target = e.target as Element
      const preset = target.closest<HTMLElement>('[data-set]')
      if (preset !== null) {
        area.value = preset.dataset['set']!.split('|').join('\n')
        this.#show()
      }
      const wrote = target.closest<HTMLElement>('[data-wrote]')
      if (wrote !== null) {
        this.#written.clear()
        if (wrote.dataset['wrote'] === 'all')
          for (const box of this.querySelectorAll<HTMLInputElement>('input[data-file]'))
            this.#written.add(box.dataset['file']!)
        this.#show()
      }
    })
    this.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement
      if (box.dataset['file'] === undefined) return
      if (box.checked) this.#written.add(box.dataset['file'])
      else this.#written.delete(box.dataset['file'])
      this.#show()
    })
    this.#show()
  }

  #area = () => this.querySelector<HTMLTextAreaElement>('textarea')!

  #show() {
    const view = render({
      mode: this.dataset['mode'] as Mode,
      project: this.dataset['project']!,
      entries: parsePatterns(this.#area().value),
      written: this.#written,
    })
    const focused = (document.activeElement as HTMLElement | null)?.dataset['file']
    this.querySelector('.gt-pats')!.innerHTML = view.patterns
    this.querySelector('.gt-tree')!.innerHTML = view.tree
    const term = this.querySelector<HTMLElement>('.gt-term')!
    term.innerHTML = view.terminal
    term.hidden = view.terminal === ''
    this.querySelector('.vx-say')!.textContent = view.say
    // A checkbox the reader just toggled is re-rendered: keep their place.
    if (focused !== undefined)
      this.querySelector<HTMLInputElement>(`input[data-file="${CSS.escape(focused)}"]`)?.focus()
  }
}

customElements.define('vx-glob-tester', GlobTester)
