// One way to say what a memo's answer depends on. A memo's token is built
// from a declaration naming every field of the input its computation reads:
// a part of the token, a field the computation does not read (and why), or
// one the memo cannot remember while it is set. `Depends<T>` requires every
// field of `T`, so a field added to a memo's input is a type error at the
// memo until the declaration says which: a dependency cannot be missed by
// omission, which a hand-built list of parts allowed.

import { xxh3hex } from './hash.js'

/** A field the computation does not read to make its answer, with why. */
export interface Unread {
  readonly unread: string
}

/** A field the memo cannot remember an answer for while it is set, with why. */
export interface OnlyAbsent {
  readonly onlyAbsent: string
}

export const unread = (why: string): Unread => ({ unread: why })
export const onlyAbsent = (why: string): OnlyAbsent => ({ onlyAbsent: why })

/** The field's part of the token; undefined when the memo cannot vouch for this value. */
export type Part<V, T, C> = (value: V, of: T, ctx: C) => string | undefined

type ValueOf<T, K extends keyof T> = {} extends Pick<T, K> ? T[K] | undefined : T[K]

/** What a memo's answer depends on: every field of `T`, each declared. */
export type Depends<T, C = void> = {
  readonly [K in keyof T]-?: Part<ValueOf<T, K>, T, C> | Unread | OnlyAbsent
}

/** A declaration compiled once: its parts in declaration order. */
export interface MemoParts<T, C = void> {
  /** Push the parts of `of` onto `out`; false when the memo cannot answer for it. */
  push(of: T, ctx: C, out: string[]): boolean
  /** `head` (the memo's version) and the parts of `of`, hashed; undefined when it cannot answer. */
  token(head: string, of: T, ctx: C): string | undefined
  /** The declaration less `keys`, whose parts another token already names. */
  without(keys: readonly (keyof T & string)[]): MemoParts<T, C>
}

type Step<T, C> = { key: keyof T & string; part: Part<unknown, T, C> | undefined }

export function memoParts<T, C = void>(depends: Depends<T, C>): MemoParts<T, C> {
  const steps: Step<T, C>[] = []
  for (const key of Object.keys(depends) as (keyof T & string)[]) {
    const dep = depends[key]
    if (typeof dep === 'function') steps.push({ key, part: dep as Part<unknown, T, C> })
    else if ('onlyAbsent' in dep) steps.push({ key, part: undefined })
  }
  return compiled(steps)
}

function compiled<T, C>(steps: readonly Step<T, C>[]): MemoParts<T, C> {
  const push = (of: T, ctx: C, out: string[]): boolean => {
    for (const { key, part } of steps) {
      const value = of[key]
      if (part === undefined) {
        if (value !== undefined) return false
        continue
      }
      const p = part(value, of, ctx)
      if (p === undefined) return false
      out.push(p)
    }
    return true
  }
  return {
    push,
    token(head, of, ctx) {
      const out = [head]
      return push(of, ctx, out) ? xxh3hex(out.join('\0')) : undefined
    },
    without(keys) {
      const drop = new Set<string>(keys)
      return compiled(steps.filter((s) => s.part === undefined || !drop.has(s.key)))
    },
  }
}
