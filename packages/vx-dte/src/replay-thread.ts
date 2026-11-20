// A thread of `playAside` (replays.ts): takes fleets until none is left.
import { type ReplayJob, takeFleets } from './replays.js'

declare const self: Worker

self.onmessage = (ev: MessageEvent<ReplayJob>) => {
  takeFleets(ev.data)
}
