// Animation clock — a single 10 Hz signal that drives the spinner
// frame (and any other periodic UI). Putting this in a context means
// all spinners share one timer instead of each component spawning
// its own setInterval.

import { createSignal, onCleanup, onMount } from 'solid-js'
import { createSimpleContext } from './helper.tsx'

const TICK_MS = 100

const { provider: ClockProvider, use: useClock } = createSimpleContext({
  name: 'Clock',
  init: () => {
    const [tick, setTick] = createSignal(0)
    let timer: ReturnType<typeof setInterval> | null = null
    onMount(() => {
      timer = setInterval(() => setTick((t) => t + 1), TICK_MS)
    })
    onCleanup(() => {
      if (timer) clearInterval(timer)
      timer = null
    })
    return { tick }
  },
})

export { ClockProvider, useClock }
