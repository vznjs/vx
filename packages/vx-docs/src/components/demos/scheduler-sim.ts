// `<vx-scheduler-sim>`: enhances the static charts `SchedulerSim.astro`
// renders. It unhides the controls (the worker count, the policy of each
// chart, a duration and a "no history" box per task), hides the finish
// table the worker count replaces, and on every change reruns the schedules
// and redraws both charts and the bound through the same model functions
// the static page was built with.
// The schedules come from vx-bench's simulator over vx's own ranking code;
// nothing here orders a task.
import {
  DEFAULT_PAIR,
  DEFAULT_WORKERS,
  MAX_SECONDS,
  POLICY_NAME,
  POLICY_NOTE,
  SIM_TASKS,
  boundsSentence,
  criticalPath,
  ganttSvg,
  lowerBound,
  schedule,
  secs,
  type Policy,
  type SimTask,
} from './model/scheduler-sim.js'

const HINT = 'Change the workers, a chart, or a task time.'

class SchedulerSim extends HTMLElement {
  #workers = DEFAULT_WORKERS
  #pair: [Policy, Policy] = [...DEFAULT_PAIR]
  #seconds = new Map(SIM_TASKS.map((t) => [t.id, t.dur / 1000]))
  #unknown = new Set<string>()

  constructor() {
    super()
    this.addEventListener('change', (e) => this.#changed(e.target as HTMLElement, true))
    this.addEventListener('input', (e) => this.#changed(e.target as HTMLElement, false))
    this.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.reset') !== null) this.#reset()
    })
  }

  connectedCallback() {
    for (const el of this.querySelectorAll<HTMLElement>('.controls, .status, .js-only')) {
      el.hidden = false
    }
    for (const el of this.querySelectorAll<HTMLElement>('.dur, .finish')) el.hidden = true
    this.#render(HINT)
  }

  #changed(target: HTMLElement, committed: boolean) {
    if (target instanceof HTMLSelectElement) {
      if (target.name === 'workers') this.#workers = Number(target.value)
      else this.#pair[Number(target.dataset['slot'])] = target.value as Policy
    } else if (target instanceof HTMLInputElement) {
      const id = target.closest<HTMLElement>('[data-task-row]')!.dataset['taskRow']!
      if (target.type === 'checkbox') {
        if (target.checked) this.#unknown.add(id)
        else this.#unknown.delete(id)
      } else {
        const value = Number(target.value)
        const valid = Number.isInteger(value) && value >= 1 && value <= MAX_SECONDS
        // A half-typed value waits; leaving the field puts the last good one back.
        if (!valid) {
          if (committed) target.value = String(this.#seconds.get(id))
          return
        }
        if (value === this.#seconds.get(id)) return
        this.#seconds.set(id, value)
      }
    } else {
      return
    }
    this.#render()
  }

  #reset() {
    this.#workers = DEFAULT_WORKERS
    this.#pair = [...DEFAULT_PAIR]
    this.#seconds = new Map(SIM_TASKS.map((t) => [t.id, t.dur / 1000]))
    this.#unknown.clear()
    this.querySelector<HTMLSelectElement>('select[name="workers"]')!.value = String(this.#workers)
    for (const select of this.querySelectorAll<HTMLSelectElement>('select[name="policy"]')) {
      select.value = this.#pair[Number(select.dataset['slot'])]!
    }
    for (const row of this.querySelectorAll<HTMLElement>('[data-task-row]')) {
      const id = row.dataset['taskRow']!
      row.querySelector<HTMLInputElement>('input[type="number"]')!.value = String(
        this.#seconds.get(id),
      )
      row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false
    }
    this.#render()
  }

  #render(status?: string) {
    const tasks: SimTask[] = SIM_TASKS.map((t) => ({ ...t, dur: this.#seconds.get(t.id)! * 1000 }))
    const unknown = this.#unknown
    const critical = new Set(criticalPath(tasks).chain)
    const charts = this.#pair.map((p) => schedule(tasks, unknown, p, this.#workers))
    const span = Math.max(...charts.map((c) => c.makespan))
    const bound = lowerBound(tasks, this.#workers)
    for (const [slot, c] of charts.entries()) {
      const chart = this.querySelector<HTMLElement>(`.chart[data-slot="${slot}"]`)!
      chart.querySelector('.policy')!.textContent = POLICY_NAME[c.policy]
      chart.querySelector('.note')!.textContent = POLICY_NOTE[c.policy]
      chart.querySelector('.done')!.textContent = secs(c.makespan)
      chart.querySelector('.gantt')!.innerHTML = ganttSvg(c, span, bound, unknown, critical)
    }
    this.querySelector('.bounds')!.textContent = boundsSentence(tasks, this.#workers)
    const [a, b] = charts as [(typeof charts)[0], (typeof charts)[0]]
    const on = this.#workers === 1 ? '1 worker' : `${this.#workers} workers`
    this.querySelector('.status')!.textContent =
      status ??
      `${on}: ${POLICY_NAME[a.policy]} ${secs(a.makespan)}, ${POLICY_NAME[b.policy]} ${secs(b.makespan)}.`
  }
}

customElements.define('vx-scheduler-sim', SchedulerSim)
