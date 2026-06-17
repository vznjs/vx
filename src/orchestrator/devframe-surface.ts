// The devframe surface for a vx run: one definition that exposes the run
// as a live streaming channel (`vx:events`, the raw WireEvent feed) plus a
// patch-synced shared state (`vx:run`, the reduced RunState aggregate).
// A host adapter (dev server / MCP — see cli wiring) mounts this same
// definition; this module owns only the translation from our in-process
// event bus into devframe's streaming + shared-state primitives.
//
// devframe is touched ONLY through type-only imports here, so core `vx`
// never gains a runtime dependency on it — the host that actually boots a
// devframe server imports the runtime adapter dynamically and is the
// optional, opt-in path. See docs/design/event-stream-2026-06.md.

import type { DevframeDefinition, DevframeNodeContext, RpcStreamingChannel } from 'devframe'
import { VERSION } from '../version.js'
import { toWireEvent, type EventBus, type WireEvent } from './events.js'
import { initRunState, reduce, type RunState } from './run-state.js'

// Type the `vx:run` shared-state key so `ctx.rpc.sharedState.get` is
// checked against our aggregate shape.
declare module 'devframe' {
  interface DevframeRpcSharedStates {
    'vx:run': RunState
  }
}

export interface VxSurfaceOptions {
  /** Stream id for the run's event feed. One run → one stream. */
  streamId?: string
}

/**
 * Build a devframe definition that mirrors a single run's bus onto
 * devframe's wire. `setup` runs at host boot (before the run emits), so
 * it subscribes to the bus, forwards every event onto the `vx:events`
 * stream, and folds it into the `vx:run` shared state. The host syncs
 * both to any connected client (web SPA, MCP resource).
 */
export function createVxSurface(bus: EventBus, options: VxSurfaceOptions = {}): DevframeDefinition {
  const streamId = options.streamId ?? 'run'
  return {
    id: 'vx',
    name: 'vx',
    version: VERSION,
    async setup(ctx: DevframeNodeContext) {
      const channel: RpcStreamingChannel<WireEvent> = ctx.rpc.streaming.create('vx:events')
      const stream = channel.start({ id: streamId })
      const state = await ctx.rpc.sharedState.get('vx:run', { initialValue: initRunState() })

      // Local snapshot fed to `reduce`; the shared state is updated by
      // assigning the new snapshot onto its draft (pure reduce → diffable
      // patch). Kept beside the shared state rather than read back from it
      // so reduction never depends on devframe's immutable accessors.
      let snapshot = initRunState()

      bus.subscribe((event) => {
        stream.write(toWireEvent(event))
        snapshot = reduce(snapshot, event)
        const next = snapshot
        state.mutate((draft) => {
          Object.assign(draft, next)
        })
        if (event.kind === 'run:end') stream.close()
      })
    },
  }
}
