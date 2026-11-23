// `<vx-graph-explorer>`: enhances `GraphExplorer.astro`. It opens the page's
// sample plan, or one the reader pastes or drops (`vx run … --dry --format
// json`), draws the picked task's world (what it waits on above, what waits
// on it below), names its predicted status, and, given a second task, lights
// the chain of edges between them. Nothing is sent anywhere.
import {
  layers,
  parsePlan,
  search,
  statusTone,
  statusWords,
  upstream,
  whyDepends,
  type Graph,
} from './model/graph-explorer.js'

/** Past this many boxes the picture stops helping; the lists still say it all. */
const MAX_DRAWN = 40
const CHAR = 7.4
const BOX_H = 30
const ROW_H = 70
const GAP = 14
const PAD = 8

class GraphExplorer extends HTMLElement {
  #graph: Graph | null = null

  connectedCallback() {
    this.querySelector<HTMLElement>('.controls')!.hidden = false
    this.querySelector<HTMLElement>('.own')!.hidden = false
    this.querySelector<HTMLElement>('.js-hint')!.hidden = true
    this.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.read') !== null) this.#read(this.#plan().value)
      const link = (e.target as Element).closest<Element>('[data-task]')
      if (link !== null) this.#pick(link.getAttribute('data-task')!)
    })
    this.addEventListener('keydown', (e) => {
      const node = (e.target as Element).closest<Element>('g[data-task]')
      if (node !== null && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        this.#pick(node.getAttribute('data-task')!)
      }
    })
    this.addEventListener('input', (e) => {
      if ((e.target as Element).matches('.find, .why-to')) this.#show()
    })
    this.querySelector<HTMLInputElement>('.file')!.addEventListener('change', (e) => {
      void this.#open((e.target as HTMLInputElement).files?.[0])
    })
    this.#plan().addEventListener('dragover', (e) => e.preventDefault())
    this.#plan().addEventListener('drop', (e) => {
      e.preventDefault()
      void this.#open(e.dataTransfer?.files[0])
    })
    const sample = this.querySelector('.sample')?.textContent
    if (sample) {
      const pick = this.querySelector<HTMLElement>('.controls')!.dataset['pick']
      if (pick !== undefined) this.#find().value = pick
      this.#read(sample, 'The demo workspace')
    }
  }

  async #open(file: File | undefined) {
    if (file === undefined) return
    const text = await file.text()
    this.#plan().value = text
    this.#read(text)
  }

  #plan = () => this.querySelector<HTMLTextAreaElement>('.plan')!
  #find = () => this.querySelector<HTMLInputElement>('.find')!

  #pick(id: string) {
    this.#find().value = id
    this.#show()
  }

  #say(text: string) {
    const status = this.querySelector<HTMLElement>('.status')!
    status.hidden = false
    status.textContent = text
  }

  #read(text: string, name = 'Your plan') {
    const parsed = parsePlan(text)
    if ('error' in parsed) {
      this.#graph = null
      this.querySelector<HTMLElement>('.out')!.hidden = true
      this.querySelector<HTMLElement>('.draw')!.hidden = true
      return this.#say(parsed.error)
    }
    this.#graph = parsed
    const ids = this.querySelector('datalist')!
    ids.replaceChildren(
      ...search(parsed, '').map((id) =>
        Object.assign(document.createElement('option'), { value: id }),
      ),
    )
    this.#say(`${name}: ${parsed.tasks.size} tasks. Click a box, or type a task.`)
    this.#show()
  }

  #show() {
    const graph = this.#graph
    const out = this.querySelector<HTMLElement>('.out')!
    const draw = this.querySelector<HTMLElement>('.draw')!
    if (graph === null) return
    const query = this.#find().value.trim()
    const id = graph.tasks.has(query) ? query : search(graph, query)[0]
    if (query === '' || id === undefined) {
      out.hidden = true
      draw.hidden = true
      if (query !== '') this.#say(`No task matches “${query}”.`)
      return
    }
    const t = graph.tasks.get(id)!
    const list = (ids: readonly string[]) =>
      ids.length === 0
        ? '<li class="is-muted">nothing</li>'
        : ids
            .map((d) => `<li><button type="button" data-task="${esc(d)}">${esc(d)}</button></li>`)
            .join('')
    const to = this.querySelector<HTMLInputElement>('.why-to')!.value.trim()
    const toId = to === '' ? undefined : graph.tasks.has(to) ? to : search(graph, to)[0]
    const chain = toId === undefined ? null : whyDepends(graph, id, toId)
    const why =
      toId === undefined
        ? ''
        : chain === null
          ? `<p><strong>${esc(id)}</strong> never waits on <strong>${esc(toId)}</strong>.</p>`
          : `<p>Why it waits on <strong>${esc(toId)}</strong>: <code>${chain.map(esc).join(' → ')}</code></p>`
    const onPath = graph.criticalPath.includes(id)
      ? ' It is on the <span class="is-accent">longest path</span> of the run.'
      : ''
    const n = upstream(graph, id).size
    const tone = statusTone(t.cacheStatus)
    out.hidden = false
    out.innerHTML =
      `<p><strong>${esc(id)}</strong>: <span style="color: var(--vx-${tone})">${esc(statusWords(t.cacheStatus))}</span>.${onPath} ` +
      (n === 0
        ? 'It waits on nothing.</p>'
        : `It waits on ${n} task${n === 1 ? '' : 's'} in all.</p>`) +
      why +
      `<p class="vx-label">Waits on</p><ul>${list(t.deps)}</ul>` +
      `<p class="vx-label">Waited on by</p><ul>${list(graph.dependents.get(id) ?? [])}</ul>`
    draw.hidden = false
    draw.innerHTML = picture(
      graph,
      id,
      chain ?? [],
      Math.max(300, draw.clientWidth || this.clientWidth),
    )
  }
}

/** The picked task's world as an SVG: rows top to bottom, edges pointing down. */
function picture(graph: Graph, id: string, chain: readonly string[], fit: number): string {
  const { rows: layered, edges } = layers(graph, id)
  const count = layered.reduce((s, r) => s + r.length, 0)
  if (count > MAX_DRAWN) {
    return `<p class="legend">${count} tasks in this task's world: too many to draw. The lists below name them.</p>`
  }
  const w = (n: string) => Math.ceil(n.length * CHAR) + 2 * PAD + 6
  // A row wider than the frame wraps onto the next, so a phone keeps the
  // text readable; a wrapped row's tasks wait on nothing in it, so every
  // edge still points down.
  const rows: string[][] = []
  for (const layer of layered) {
    let row: string[] = []
    let used = 0
    for (const n of layer) {
      if (row.length > 0 && used + GAP + w(n) > fit) {
        rows.push(row)
        row = []
        used = 0
      }
      used += (row.length > 0 ? GAP : 0) + w(n)
      row.push(n)
    }
    rows.push(row)
  }
  const width = Math.max(
    300,
    ...rows.map((r) => r.reduce((s, n) => s + w(n), 0) + GAP * (r.length - 1)),
  )
  const at = new Map<string, { x: number; y: number; w: number }>()
  rows.forEach((row, i) => {
    let x = (width - (row.reduce((s, n) => s + w(n), 0) + GAP * (row.length - 1))) / 2
    for (const n of row) {
      at.set(n, { x, y: 10 + i * ROW_H, w: w(n) })
      x += w(n) + GAP
    }
  })
  const height = 10 + (rows.length - 1) * ROW_H + BOX_H + 10
  const lit = new Set(chain.slice(1).map((to, i) => `${to}\0${chain[i]}`))
  const lines = edges
    .map(([from, to]) => {
      const a = at.get(from)!
      const b = at.get(to)!
      const x1 = a.x + a.w / 2
      const y1 = a.y + BOX_H
      const x2 = b.x + b.w / 2
      const y2 = b.y - 4
      const mid = (y1 + y2) / 2
      const on = lit.has(`${from}\0${to}`)
      return `<path d="M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}" fill="none" stroke="var(${on ? '--vx-accent' : '--vx-border'})" stroke-width="${on ? 2.5 : 1.5}" marker-end="url(#vx-graph-head${on ? '-lit' : ''})"/>`
    })
    .join('')
  const boxes = [...at]
    .map(([n, p]) => {
      const t = graph.tasks.get(n)!
      const picked = n === id
      const colour = `var(--vx-${statusTone(t.cacheStatus)})`
      return (
        `<g data-task="${esc(n)}" role="button" tabindex="0" aria-label="${esc(n)}: ${esc(statusWords(t.cacheStatus))}" style="cursor:pointer">` +
        `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${BOX_H}" rx="8" fill="var(--vx-surface-2)" stroke="${picked ? 'var(--vx-accent)' : colour}" stroke-width="${picked ? 2.5 : 1.5}"/>` +
        `<text x="${p.x + p.w / 2}" y="${p.y + BOX_H / 2 + 4}" text-anchor="middle" font-family="var(--vx-mono)" font-size="12" fill="var(--vx-fg)"${picked ? ' font-weight="700"' : ''}>${esc(n)}</text>` +
        `</g>`
      )
    })
    .join('')
  const head = (name: string, colour: string) =>
    `<marker id="${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(${colour})"/></marker>`
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" role="group" aria-label="${esc(id)}: what it waits on above it, what waits on it below">` +
    `<defs>${head('vx-graph-head', '--vx-border')}${head('vx-graph-head-lit', '--vx-accent')}</defs>` +
    lines +
    boxes +
    `</svg>` +
    `<p class="legend"><span class="is-accent">▢ picked</span> · <span class="is-ok">▢ cached</span> · <span style="color: var(--vx-link)">▢ runs</span> · arrows point to the task that waits</p>`
  )
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

customElements.define('vx-graph-explorer', GraphExplorer)
