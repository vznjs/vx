// Ergonomic spec authoring for json-render.
//
// json-render renderers consume a FLAT element tree (`{ root, elements }`).
// Hand-authoring that is painful, so we author a nested tree with `el()` and
// flatten it via the library's own `nestedToFlat` (which preserves element-
// level fields like `visible`/`repeat`). The result is a genuine json-render
// `Spec`; the catalog + Renderer do the real rendering, binding props to the
// page's `state` at runtime.

import { nestedToFlat } from '@json-render/core'
import type { Spec } from '@json-render/solid'

export interface Node {
  type: string
  props?: Record<string, unknown>
  children?: Array<Node | null | undefined | false>
  visible?: unknown
  repeat?: { statePath: string; key?: string }
}

interface ElOpts {
  visible?: unknown
  repeat?: { statePath: string; key?: string }
}

/** A catalog element. Falsy children are dropped (for `cond && el(...)`). */
export function el(
  type: string,
  props?: Record<string, unknown>,
  children?: Array<Node | null | undefined | false>,
  opts?: ElOpts,
): Node {
  return { type, props: props ?? {}, children, visible: opts?.visible, repeat: opts?.repeat }
}

/** Directive shorthands for props in static specs. */
export const S = (path: string) => ({ $state: path })
export const C = (fn: string, args: Record<string, unknown> = {}) => ({ $computed: fn, args })
export const T = (template: string) => ({ $template: template })

/** Flatten a nested authoring tree into the json-render `Spec` format. */
export function toSpec(root: Node): Spec {
  return nestedToFlat(prune(root) as unknown as Record<string, unknown>)
}

function prune(node: Node): Node {
  const kids = (node.children ?? []).filter(Boolean) as Node[]
  const out: Node = { type: node.type, props: node.props ?? {}, children: kids.map(prune) }
  if (node.visible !== undefined) out.visible = node.visible
  if (node.repeat !== undefined) out.repeat = node.repeat
  return out
}
