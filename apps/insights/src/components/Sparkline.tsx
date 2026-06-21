// Tiny inline SVG sparkline — no chart library. Renders a line + an
// optional cache-hit dot marker series, sized to its container.

import { For } from 'solid-js'

export interface SparkPoint {
  value: number
  hit?: boolean
}

export function Sparkline(props: {
  data: readonly SparkPoint[]
  width?: number
  height?: number
  strokeClass?: string
}) {
  const w = () => props.width ?? 280
  const h = () => props.height ?? 36
  const data = () => props.data
  const max = () => Math.max(1, ...data().map((p) => p.value))
  const min = () => Math.min(...data().map((p) => p.value), 0)
  const range = () => Math.max(1, max() - min())

  const xs = () => {
    const n = data().length
    if (n <= 1) return [w() / 2]
    return data().map((_, i) => (i / (n - 1)) * w())
  }
  const ys = () => data().map((p) => h() - ((p.value - min()) / range()) * h())

  const linePath = () => {
    const X = xs()
    const Y = ys()
    if (X.length === 0) return ''
    return X.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${Y[i]!.toFixed(1)}`).join(' ')
  }

  const areaPath = () => {
    const X = xs()
    const Y = ys()
    if (X.length === 0) return ''
    const line = X.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${Y[i]!.toFixed(1)}`).join(' ')
    return `${line} L${X[X.length - 1]!.toFixed(1)},${h()} L${X[0]!.toFixed(1)},${h()} Z`
  }

  return (
    <svg viewBox={`0 0 ${w()} ${h()}`} width={w()} height={h()} class="block">
      <path d={areaPath()} class="fill-accent/10" />
      <path
        d={linePath()}
        class={props.strokeClass ?? 'stroke-accent'}
        fill="none"
        stroke-width="1.5"
      />
      <For each={data()}>
        {(pt, i) => (
          <circle
            cx={xs()[i()]!.toFixed(1)}
            cy={ys()[i()]!.toFixed(1)}
            r={pt.hit ? 2 : 1.5}
            class={pt.hit ? 'fill-cache' : 'fill-accent'}
          />
        )}
      </For>
    </svg>
  )
}
