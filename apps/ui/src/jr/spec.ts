// Ergonomic spec authoring for json-render.
//
// json-render renderers consume a FLAT element tree (`{ root, elements }`).
// Hand-authoring that is painful, so we author a nested tree with `el()` and
// flatten it via the library's own `nestedToFlat`. The result is a genuine
// json-render `Spec` — the catalog + Renderer are doing the real rendering.

import { nestedToFlat } from '@json-render/core'
import type { Spec } from '@json-render/solid'

export interface Node {
  type: string
  props?: Record<string, unknown>
  children?: Array<Node | null | undefined | false>
}

/** A catalog element. Falsy children are dropped (for `cond && el(...)`). */
export function el(
  type: string,
  props?: Record<string, unknown>,
  children?: Array<Node | null | undefined | false>,
): Node {
  return { type, props: props ?? {}, children }
}

/** Flatten a nested authoring tree into the json-render `Spec` format. */
export function toSpec(root: Node): Spec {
  return nestedToFlat(prune(root) as unknown as Record<string, unknown>)
}

function prune(node: Node): Node {
  const kids = (node.children ?? []).filter(Boolean) as Node[]
  return { type: node.type, props: node.props ?? {}, children: kids.map(prune) }
}
