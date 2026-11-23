// Where a JSON (or JSONC) text stops parsing, as `line:column`: Bun's
// parsers name what they met, never where, and a long manifest was left to
// bisect. Run only on text a parser already refused.

/** The 1-based `line:column` of the first syntax error in `text`, or undefined when it finds none. */
export function jsonErrorAt(text: string, jsonc = false): string | undefined {
  let i = 0
  const fail = (): never => {
    throw i
  }
  const ws = (): void => {
    for (;;) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else if (jsonc && c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (jsonc && c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        if (end === -1) fail()
        i = end + 2
      } else return
    }
  }
  const string = (): void => {
    if (text[i] !== '"') fail()
    i++
    for (;;) {
      const c = text[i]
      if (c === undefined || c < ' ') fail()
      if (c === '"') return void i++
      if (c === '\\') {
        i++
        if (text[i] === 'u') {
          for (let k = 1; k <= 4; k++) if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) fail()
          i += 5
        } else if (text[i] !== undefined && '"\\/bfnrt'.includes(text[i]!)) i++
        else fail()
      } else i++
    }
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      i++
      ws()
      if (text[i] === close) return void i++
      for (;;) {
        if (close === '}') {
          ws()
          string()
          ws()
          if (text[i] !== ':') fail()
          i++
        }
        value()
        ws()
        if (text[i] === close) return void i++
        if (text[i] !== ',') fail()
        i++
        ws()
        if (jsonc && text[i] === close) return void i++
      }
    }
    if (c === '"') return string()
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i, i + 400),
    )
    if (literal === null) fail()
    i += literal![0].length
  }
  try {
    value()
    ws()
    if (i < text.length) fail()
    return undefined
  } catch (at) {
    if (typeof at !== 'number') throw at
    const before = text.slice(0, at)
    const line = before.split('\n').length
    return `${line}:${at - before.lastIndexOf('\n')}`
  }
}
