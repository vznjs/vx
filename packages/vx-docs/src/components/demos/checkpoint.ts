// `<vx-checkpoint>`: enhances the question and answer `Checkpoint.astro`
// renders. It unhides a checkbox per task and a Check button, and hides the
// answer. Check imports vx's planner from the site (once per page: the
// module is cached), computes the answer as the build did, and marks each
// task right, missed or wrong by colour; the live region sums it up and
// names, with its reason, each task missed or wrong.
// What it computes is `model/checkpoint.ts`; this only wires it to the markup.
import {
  CHECKPOINTS,
  answerCheckpoint,
  codeSpans,
  markAnswer,
  markLine,
  verdictSentence,
  type Checkpoint as CheckpointQuestion,
  type CheckpointAnswer,
  type CheckpointId,
} from './model/checkpoint.js'
import type { Planner } from './model/playground-view.js'

function withCode(parent: HTMLElement, text: string): HTMLElement {
  parent.append(
    ...codeSpans(text).map((s) => {
      if (!s.code) return s.text
      const c = document.createElement('code')
      c.textContent = s.text
      return c
    }),
  )
  return parent
}

class Checkpoint extends HTMLElement {
  #answer: Promise<CheckpointAnswer> | undefined
  #checking = false

  #el<T extends HTMLElement>(selector: string): T {
    return this.querySelector<T>(selector)!
  }

  connectedCallback() {
    this.#el('.form').hidden = false
    this.#el('.answer').hidden = true
    this.addEventListener('click', (e) => {
      const action = (e.target as Element).closest<HTMLButtonElement>('button[data-action]')
        ?.dataset['action']
      if (action === 'check') void this.#check()
    })
  }

  #checkpoint(): CheckpointQuestion {
    return CHECKPOINTS[this.#el('.form').dataset['checkpoint'] as CheckpointId]
  }

  #load(): Promise<CheckpointAnswer> {
    const url = this.#el('.form').dataset['planner']!
    return (import(/* @vite-ignore */ url) as Promise<Planner>).then((planner) =>
      answerCheckpoint(planner, this.#checkpoint()),
    )
  }

  async #check() {
    if (this.#checking) return
    this.#checking = true
    const button = this.#el<HTMLButtonElement>('button[data-action="check"]')
    button.disabled = true
    const result = this.#el('.result')
    result.textContent = 'Checking…'
    try {
      let answer: CheckpointAnswer
      try {
        answer = await (this.#answer ??= this.#load())
      } catch (e) {
        this.#answer = undefined
        result.textContent = `The check did not run: ${e instanceof Error ? e.message : String(e)}`
        return
      }
      const boxes = [...this.querySelectorAll<HTMLInputElement>('.choices input')]
      const ticked = new Set(boxes.filter((b) => b.checked).map((b) => b.value))
      const marks = markAnswer(answer, ticked)
      for (const b of boxes) {
        const mark = marks.find((m) => m.id === b.value)!
        b.closest('li')!.dataset['verdict'] = mark.verdict
      }
      const verdict = document.createElement('p')
      verdict.className = 'verdict'
      verdict.textContent = verdictSentence(marks)
      const list = document.createElement('ul')
      list.className = 'marks'
      list.append(
        ...marks
          .filter((m) => m.verdict !== 'right')
          .map((m) => {
            const li = document.createElement('li')
            li.dataset['verdict'] = m.verdict
            li.textContent = markLine(answer.form, m)
            return li
          }),
      )
      result.replaceChildren(verdict, list)
      const note = this.#checkpoint().note
      if (note !== undefined) result.append(withCode(document.createElement('p'), note))
    } finally {
      this.#checking = false
      button.disabled = false
    }
  }
}

customElements.define('vx-checkpoint', Checkpoint)
