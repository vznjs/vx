// `<vx-what-runs>`: the quickstart's "guess, then see". The static render is
// a table: one row per change, the task line vx printed for it (a real run)
// and why. With script the reader picks a change, guesses whether vite runs,
// then sees the row. No score is kept: the reveal is the reward.
class WhatRuns extends HTMLElement {
  connectedCallback() {
    const rows = [...this.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    const table = this.querySelector('table')!
    const picks = this.querySelector<HTMLElement>('.picks')!
    const guess = this.querySelector<HTMLElement>('.guess')!
    const say = this.querySelector<HTMLElement>('.vx-say')!
    const line = this.querySelector<HTMLElement>('.line')!
    // widget.css gives a table display: block, which outranks [hidden].
    table.style.display = 'none'
    picks.hidden = false
    say.hidden = false
    say.textContent = 'Pick a change.'
    let at: HTMLTableRowElement | null = null
    for (const row of rows) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = row.cells[0]!.textContent!.trim()
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('click', () => {
        at = row
        for (const o of picks.querySelectorAll('button'))
          o.setAttribute('aria-pressed', String(o === b))
        guess.hidden = false
        line.hidden = true
        say.hidden = false
        say.textContent = `${b.textContent}, then vx run build. Does vite run?`
      })
      picks.append(b)
    }
    for (const b of guess.querySelectorAll<HTMLButtonElement>('button'))
      b.addEventListener('click', () => {
        if (at === null) return
        const runs = at.dataset['runs'] === 'yes'
        const right = (b.dataset['guess'] === 'yes') === runs
        line.hidden = false
        line.innerHTML = at.cells[1]!.innerHTML
        line.className = `line ${runs ? 'is-warn' : 'is-ok'}`
        say.textContent = `${right ? 'Right.' : 'Not this time.'} ${at.cells[2]!.textContent!.trim()}`
        guess.hidden = true
      })
  }
}

customElements.define('vx-what-runs', WhatRuns)
