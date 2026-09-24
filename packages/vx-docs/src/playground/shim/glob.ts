// `Bun.Glob`'s `match()` for a runtime without Bun. Only `match`: the plan
// never scans (output scans happen on execution, which the playground does
// not do).
//
// A line-for-line port of the matcher `Bun.Glob.prototype.match` calls:
// `bun_glob::r#match` in src/glob/matcher.rs of oven-sh/bun, tag bun-v1.4.2,
// commit 744846f844374847c902b5e7fd59b4342a51ef99 (the binding is
// `Glob::r#match` in src/runtime/api/glob.rs). The Rust names are kept in
// the comments so the two diff side by side. Parity with Bun is held by
// tests/playground-glob.test.ts in this package; the scoreboard against
// picomatch is packages/vx-bench/playground-spike/glob-equiv.ts.
//
// Bun is MIT (Copyright (c) Oven, https://github.com/oven-sh/bun/blob/main/LICENSE.md).
// matcher.rs itself carries this notice, reproduced as the licence asks:
//
//   Portions of this file are derived from works under the MIT License:
//
//   Copyright (c) 2023 Devon Govett
//   Copyright (c) 2023 Stephen Gregoratto
//   Copyright (c) 2024 shulaoda
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
//   THE SOFTWARE.
//
// The Rust walks BYTES of UTF-8, so this does too: the binding hands it the
// pattern and the path as UTF-8, and a lone surrogate becomes U+FFFD on both
// sides — what TextEncoder does. The separator is `is_sep_native`, which is
// `/` alone off Windows; the playground models a POSIX CLI.

// Brace
interface Brace {
  openBraceIdx: number
  branchIdx: number
  // Index of the matching `}`, or `glob.length` if the group is unterminated.
  closeBraceIdx: number
}

// BraceStack = BoundedArray<Brace, 10>
const BRACE_STACK_CAPACITY = 10

// Sequential brace groups multiply (`{a,b}{c,d}` = 4 alternatives); a pattern
// over this budget fails to match.
const BRACE_BRANCH_BUDGET = 10_000

// Wildcard
interface Wildcard {
  globIndex: number
  pathIndex: number
  braceDepth: number
}

// State
interface State {
  pathIndex: number
  globIndex: number
  wildcard: Wildcard
  globstar: Wildcard
  braceDepth: number
}

interface Budget {
  left: number
}

const SLASH = 0x2f
const BACKSLASH = 0x5c
const STAR = 0x2a

// State::backtrack
function backtrack(state: State): void {
  state.pathIndex = state.wildcard.pathIndex
  state.globIndex = state.wildcard.globIndex
  state.braceDepth = state.wildcard.braceDepth
}

// State::skip_to_separator
function skipToSeparator(state: State, path: Uint8Array, isEndInvalid: boolean): void {
  if (state.pathIndex === path.length) {
    state.wildcard.pathIndex += 1
    return
  }

  let pathIndex = state.pathIndex
  while (pathIndex < path.length && !isSeparator(path[pathIndex]!)) pathIndex += 1

  if (isEndInvalid || pathIndex !== path.length) pathIndex += 1

  state.wildcard.pathIndex = pathIndex
  // Rust's `Wildcard` is `Copy`: the assignment is a copy, not an alias.
  state.globstar = { ...state.wildcard }
}

// r#match
function match(glob: Uint8Array, path: Uint8Array): boolean {
  const state: State = {
    pathIndex: 0,
    globIndex: 0,
    wildcard: { globIndex: 0, pathIndex: 0, braceDepth: 0 },
    globstar: { globIndex: 0, pathIndex: 0, braceDepth: 0 },
    braceDepth: 0,
  }

  let negated = false
  while (state.globIndex < glob.length && glob[state.globIndex] === 0x21 /* ! */) {
    negated = !negated
    state.globIndex += 1
  }

  const braceStack: Brace[] = []
  const braceBudget: Budget = { left: BRACE_BRANCH_BUDGET }
  // Past the `!` prefix, so a pattern-initial `**` still starts a segment.
  const globStart = state.globIndex
  const matched = globMatchImpl(state, glob, globStart, path, braceStack, braceBudget)

  return matched !== negated
}

// glob_match_impl
function globMatchImpl(
  state: State,
  glob: Uint8Array,
  globStart: number,
  path: Uint8Array,
  braceStack: Brace[],
  braceBudget: Budget,
): boolean {
  main_loop: while (state.globIndex < glob.length || state.pathIndex < path.length) {
    if (state.globIndex < glob.length) {
      fallthrough: {
        const ch = glob[state.globIndex]!
        to_else: {
          switch (ch) {
            case STAR: {
              const isGlobstar =
                state.globIndex + 1 < glob.length && glob[state.globIndex + 1] === STAR
              if (isGlobstar) state.globIndex = skipGlobstars(glob, state.globIndex)

              state.wildcard.globIndex = state.globIndex
              state.wildcard.pathIndex =
                state.pathIndex +
                (state.pathIndex < path.length ? wtf8ByteSequenceLength(path[state.pathIndex]!) : 1)
              state.wildcard.braceDepth = state.braceDepth

              let inGlobstar = false
              if (isGlobstar) {
                state.globIndex += 2

                const isEndInvalid = state.globIndex < glob.length

                // Upstream: "FIXME: explain this bug fix".
                if (
                  isEndInvalid &&
                  state.pathIndex === path.length &&
                  glob.length - state.globIndex === 2 &&
                  isSeparator(glob[state.globIndex]!) &&
                  glob[state.globIndex + 1] === STAR
                ) {
                  continue main_loop
                }

                // `glob_index - glob_start < 3` (saturating): in `{**/a,**/b}`
                // a branch starting at `**/b` must not look into the one before.
                if (
                  (Math.max(0, state.globIndex - globStart) < 3 ||
                    glob[state.globIndex - 3] === SLASH) &&
                  (!isEndInvalid || glob[state.globIndex] === SLASH)
                ) {
                  if (isEndInvalid) state.globIndex += 1

                  skipToSeparator(state, path, isEndInvalid)
                  inGlobstar = true
                }
              } else {
                state.globIndex += 1
              }

              if (
                !inGlobstar &&
                state.pathIndex < path.length &&
                isSeparator(path[state.pathIndex]!)
              ) {
                state.wildcard = { ...state.globstar }
              }

              continue main_loop
            }
            case 0x3f /* ? */: {
              if (state.pathIndex < path.length) {
                if (!isSeparator(path[state.pathIndex]!)) {
                  state.globIndex += 1
                  state.pathIndex += wtf8ByteSequenceLength(path[state.pathIndex]!)
                  continue main_loop
                }
                break fallthrough
              } else {
                break to_else
              }
            }
            case 0x5b /* [ */: {
              if (state.pathIndex < path.length) {
                state.globIndex += 1

                let negated = false
                if (
                  state.globIndex < glob.length &&
                  (glob[state.globIndex] === 0x5e /* ^ */ || glob[state.globIndex] === 0x21) /* ! */
                ) {
                  negated = true
                  state.globIndex += 1
                }

                let first = true
                let isMatch = false

                const [c, len] = decodeWtf8RuneAt(path, state.pathIndex)

                while (
                  state.globIndex < glob.length &&
                  (first || glob[state.globIndex] !== 0x5d) /* ] */
                ) {
                  const low = getUnicode(glob, state.globIndex)
                  if (low === null) return false // Invalid pattern!
                  state.globIndex = low.globIndex

                  state.globIndex += low.len

                  let high: number
                  if (
                    state.globIndex + 1 < glob.length &&
                    glob[state.globIndex] === 0x2d /* - */ &&
                    glob[state.globIndex + 1] !== 0x5d /* ] */
                  ) {
                    state.globIndex += 1

                    const hi = getUnicode(glob, state.globIndex)
                    if (hi === null) return false // Invalid pattern!
                    state.globIndex = hi.globIndex

                    state.globIndex += hi.len
                    high = hi.c
                  } else {
                    high = low.c
                  }

                  if (low.c <= c && c <= high) isMatch = true

                  first = false
                }

                if (state.globIndex >= glob.length) return false // Invalid pattern!

                state.globIndex += 1
                if (isMatch !== negated) {
                  state.pathIndex += len
                  continue main_loop
                }
                break fallthrough
              } else {
                break to_else
              }
            }
            case 0x7b /* { */: {
              for (const brace of braceStack) {
                if (brace.openBraceIdx === state.globIndex) {
                  state.globIndex = brace.branchIdx
                  state.braceDepth += 1
                  continue main_loop
                }
              }
              return matchBrace(state, glob, path, braceStack, braceBudget)
            }
            case 0x2c /* , */:
            case 0x7d /* } */: {
              if (state.braceDepth > 0 && skipBranch(state, glob, braceStack)) {
                continue main_loop
              } else {
                break to_else
              }
            }
            default:
              break to_else
          }
        }
        if (state.pathIndex < path.length) {
          let cc = ch
          if (cc === BACKSLASH) {
            const u = unescape(glob, state.globIndex)
            if (u === null) return false // Invalid pattern!
            cc = u.c
            state.globIndex = u.globIndex
          }
          const ccLen = wtf8ByteSequenceLength(cc)

          let isMatch: boolean
          if (cc === SLASH) {
            isMatch = isSeparator(path[state.pathIndex]!)
          } else if (ccLen > 1) {
            const pi = state.pathIndex
            const gi = state.globIndex
            isMatch = pi + ccLen <= path.length && gi + ccLen <= glob.length
            for (let k = 0; isMatch && k < ccLen; k++) isMatch = path[pi + k] === glob[gi + k]
          } else {
            isMatch = path[state.pathIndex] === cc
          }

          if (isMatch) {
            state.globIndex += ccLen
            state.pathIndex += ccLen

            if (cc === SLASH) state.wildcard = { ...state.globstar }

            continue main_loop
          }
        }
      }
    }

    if (state.wildcard.pathIndex > 0 && state.wildcard.pathIndex <= path.length) {
      backtrack(state)
      continue
    }

    return false
  }

  return true
}

// match_brace
function matchBrace(
  state: State,
  glob: Uint8Array,
  path: Uint8Array,
  braceStack: Brace[],
  braceBudget: Budget,
): boolean {
  let braceDepth = 0
  let inBrackets = false

  const openBraceIndex = state.globIndex
  const closeBraceIndex = findBraceEnd(glob, openBraceIndex)

  let branchIndex = 0

  while (state.globIndex < glob.length) {
    switch (glob[state.globIndex]) {
      case 0x7b /* { */:
        if (!inBrackets) {
          braceDepth += 1
          if (braceDepth === 1) branchIndex = state.globIndex + 1
        }
        break
      case 0x7d /* } */:
        if (!inBrackets) {
          braceDepth -= 1
          if (braceDepth === 0) {
            if (
              matchBraceBranch(
                state,
                glob,
                path,
                openBraceIndex,
                branchIndex,
                closeBraceIndex,
                braceStack,
                braceBudget,
              )
            ) {
              return true
            }
            return false
          }
        }
        break
      case 0x2c /* , */:
        // A `,` inside a `[...]` class is a member, not a branch separator.
        if (braceDepth === 1 && !inBrackets) {
          if (
            matchBraceBranch(
              state,
              glob,
              path,
              openBraceIndex,
              branchIndex,
              closeBraceIndex,
              braceStack,
              braceBudget,
            )
          ) {
            return true
          }
          branchIndex = state.globIndex + 1
        }
        break
      case 0x5b /* [ */:
        if (!inBrackets) inBrackets = true
        break
      case 0x5d /* ] */:
        inBrackets = false
        break
      case BACKSLASH:
        state.globIndex += 1
        break
    }
    state.globIndex += 1
  }

  return false
}

// match_brace_branch
function matchBraceBranch(
  state: State,
  glob: Uint8Array,
  path: Uint8Array,
  openBraceIndex: number,
  branchIndex: number,
  closeBraceIndex: number,
  braceStack: Brace[],
  braceBudget: Budget,
): boolean {
  if (braceBudget.left === 0) return false
  braceBudget.left -= 1

  // exceeded brace depth
  if (braceStack.length === BRACE_STACK_CAPACITY) return false
  braceStack.push({
    openBraceIdx: openBraceIndex,
    branchIdx: branchIndex,
    closeBraceIdx: closeBraceIndex,
  })

  // `let mut branch_state = *state`: a copy, nested wildcards included.
  const branchState: State = {
    pathIndex: state.pathIndex,
    globIndex: branchIndex,
    wildcard: { ...state.wildcard },
    globstar: { ...state.globstar },
    braceDepth: braceStack.length,
  }

  const matched = globMatchImpl(branchState, glob, branchIndex, path, braceStack, braceBudget)

  braceStack.pop()

  return matched
}

// skip_branch: jumps past the `}` of the innermost stacked group that
// encloses `glob_index`, or returns false (the `,`/`}` is then a literal).
// The stack also holds already-exited sequential groups, so the lookup is by
// range, inner to outer.
function skipBranch(state: State, glob: Uint8Array, braceStack: readonly Brace[]): boolean {
  const gi = state.globIndex
  for (let f = braceStack.length - 1; f >= 0; f--) {
    const frame = braceStack[f]!
    if (frame.openBraceIdx < gi && gi <= frame.closeBraceIdx) {
      const close = frame.closeBraceIdx
      if (close < glob.length) {
        state.globIndex = close + 1
        state.braceDepth -= 1
      } else {
        state.globIndex = close
      }
      return true
    }
  }
  return false
}

// find_brace_end: the `}` matching the `{` at `openIdx`, or `glob.length`.
function findBraceEnd(glob: Uint8Array, openIdx: number): number {
  let i = openIdx
  let depth = 0
  let inBrackets = false
  while (i < glob.length) {
    const b = glob[i]
    if (b === 0x7b /* { */ && !inBrackets) depth += 1
    else if (b === 0x7d /* } */ && !inBrackets) {
      depth -= 1
      if (depth === 0) return i
    } else if (b === 0x5b /* [ */ && !inBrackets) inBrackets = true
    else if (b === 0x5d /* ] */) inBrackets = false
    else if (b === BACKSLASH) i += 1
    i += 1
  }
  return glob.length
}

// is_sep_native, off Windows
function isSeparator(c: number): boolean {
  return c === SLASH
}

// The escape table unescape and get_unicode share. `\a` is 0x61 (`a`), not
// BEL: Bun's table says so, and parity is the point.
function escaped(c: number): number {
  switch (c) {
    case 0x61 /* a */:
      return 0x61
    case 0x62 /* b */:
      return 0x08
    case 0x6e /* n */:
      return 0x0a
    case 0x72 /* r */:
      return 0x0d
    case 0x74 /* t */:
      return 0x09
    default:
      return c
  }
}

// unescape, for a `c` that is `\`: null is "Invalid pattern!".
function unescape(glob: Uint8Array, globIndex: number): { c: number; globIndex: number } | null {
  const at = globIndex + 1
  if (at >= glob.length) return null
  return { c: escaped(glob[at]!), globIndex: at }
}

// strings::wtf8_byte_sequence_length
function wtf8ByteSequenceLength(firstByte: number): number {
  if (firstByte <= 0x7f) return 1
  if (firstByte >= 0xc0 && firstByte <= 0xdf) return 2
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3
  if (firstByte >= 0xf0 && firstByte <= 0xf7) return 4
  return 1
}

// decode_wtf8_rune_at: [codepoint, byte length]
function decodeWtf8RuneAt(bytes: Uint8Array, idx: number): [number, number] {
  const len = wtf8ByteSequenceLength(bytes[idx]!)
  // `buf` is zero-filled past the end of `bytes`.
  const p0 = bytes[idx]!
  const p1 = bytes[idx + 1] ?? 0
  const p2 = bytes[idx + 2] ?? 0
  const p3 = bytes[idx + 3] ?? 0
  return [decodeWtf8Rune(p0, p1, p2, p3, len, 0xfffd), len]
}

// strings::decode_wtf8_rune_t (+ _multibyte)
function decodeWtf8Rune(
  p0: number,
  s1: number,
  s2: number,
  s3: number,
  len: number,
  zero: number,
): number {
  if (len === 1) return p0

  if ((s1 & 0xc0) !== 0x80) return zero
  if (len === 2) {
    const cp = ((p0 & 0x1f) << 6) | (s1 & 0x3f)
    return cp < 0x80 ? zero : cp
  }

  if ((s2 & 0xc0) !== 0x80) return zero
  if (len === 3) {
    const cp = ((p0 & 0x0f) << 12) | ((s1 & 0x3f) << 6) | (s2 & 0x3f)
    return cp < 0x800 ? zero : cp
  }

  if ((s3 & 0xc0) !== 0x80) return zero
  const cp = ((p0 & 0x07) << 18) | ((s1 & 0x3f) << 12) | ((s2 & 0x3f) << 6) | (s3 & 0x3f)
  return cp < 0x10000 || cp > 0x10ffff ? zero : cp
}

// get_unicode: the class member at `globIndex`, unescaped and decoded; its
// `globIndex` is where the member's last unit starts (past a `\`), and `len`
// its byte length from there. null is "Invalid pattern!".
function getUnicode(
  glob: Uint8Array,
  globIndex: number,
): { c: number; len: number; globIndex: number } | null {
  const c = glob[globIndex]!
  // ascii range excluding backslash
  if (c <= 0x7f && c !== BACKSLASH) return { c, len: 1, globIndex }
  if (c === BACKSLASH) {
    const at = globIndex + 1
    if (at >= glob.length) return null
    const e = glob[at]!
    if (e === 0x61 || e === 0x62 || e === 0x6e || e === 0x72 || e === 0x74) {
      return { c: escaped(e), len: 1, globIndex: at }
    }
    const [cp, len] = decodeWtf8RuneAt(glob, at)
    return { c: cp, len, globIndex: at }
  }
  // multi-byte sequences
  const [cp, len] = decodeWtf8RuneAt(glob, globIndex)
  return { c: cp, len, globIndex }
}

// skip_globstars: collapses `**/**/…` runs, and a trailing `/**`, onto the
// last `**`, and returns the index of that `**`.
function skipGlobstars(glob: Uint8Array, globIndex: number): number {
  let i = globIndex + 2

  while (
    i + 4 <= glob.length &&
    glob[i] === SLASH &&
    glob[i + 1] === STAR &&
    glob[i + 2] === STAR &&
    glob[i + 3] === SLASH
  ) {
    i += 3
  }

  if (i + 3 === glob.length && glob[i] === SLASH && glob[i + 1] === STAR && glob[i + 2] === STAR) {
    i += 3
  }

  return i - 2
}

const utf8 = new TextEncoder()

export class Glob {
  private readonly pattern: Uint8Array

  constructor(pattern: string) {
    this.pattern = utf8.encode(pattern)
  }

  match(path: string): boolean {
    return match(this.pattern, utf8.encode(path))
  }

  scan(): never {
    throw new Error('Glob.scan is not available in the playground: the plan never walks a disk')
  }

  scanSync(): never {
    return this.scan()
  }
}
