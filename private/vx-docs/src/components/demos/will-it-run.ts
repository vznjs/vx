// `<vx-will-it-run>`: enhances the table on "Cache a task". The reader picks
// what they did since the last build; the element shows the one line vx
// printed for it (captured from a real run) and why. Without JavaScript the
// whole table stays.
class WillItRun extends HTMLElement {
  connectedCallback() {
    const rows = [...this.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    const table = this.querySelector('table')!
    const row = document.createElement('div')
    row.className = 'vx-row'
    row.setAttribute('role', 'group')
    row.setAttribute('aria-label', 'What you did')
    const pre = document.createElement('pre')
    const say = document.createElement('p')
    say.className = 'vx-say'
    say.setAttribute('aria-live', 'polite')
    const buttons = rows.map((tr, i) => {
      const [did, line, why] = [...tr.cells]
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = did!.textContent!.trim()
      b.addEventListener('click', () => {
        for (const o of buttons) o.setAttribute('aria-pressed', String(o === b))
        pre.innerHTML = line!.querySelector('code')!.innerHTML
        say.innerHTML = why!.innerHTML
      })
      if (i === 0) queueMicrotask(() => b.click())
      return b
    })
    row.append(...buttons)
    table.replaceWith(row, pre, say)
  }
}

customElements.define('vx-will-it-run', WillItRun)
