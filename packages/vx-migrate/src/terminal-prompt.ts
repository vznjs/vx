// A token asked for on the terminal: hidden, one line, only where someone can answer.

/** Where a missing token is asked for. */
export interface TokenTerminal {
  /** stdin and stderr are both terminals: someone can answer. */
  interactive(): boolean
  /** Ask `question` on stderr with the answer hidden; resolves the line typed. */
  ask(question: string): Promise<string>
}

interface HiddenInput {
  isRaw?: boolean
  setRawMode(mode: boolean): unknown
  on(event: 'data', fn: (chunk: Buffer | string) => void): unknown
  off(event: 'data', fn: (chunk: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
}

/**
 * Read one line from a raw-mode terminal, echoing nothing. Ctrl-C and
 * Ctrl-D give up (raw mode delivers no SIGINT); backspace edits.
 */
function askHidden(
  question: string,
  input: HiddenInput,
  output: { write(s: string): unknown },
): Promise<string> {
  output.write(question)
  const wasRaw = input.isRaw === true
  input.setRawMode(true)
  input.resume()
  return new Promise((resolve, reject) => {
    let line = ''
    const done = () => {
      input.off('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
    }
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          done()
          resolve(line)
          return
        }
        if (ch === '\u0003' || ch === '\u0004') {
          done()
          reject(new Error('no token given'))
          return
        }
        if (ch === '\u007f' || ch === '\b') line = line.replace(/.$/u, '')
        else if (ch >= ' ') line += ch
      }
    }
    input.on('data', onData)
  })
}

/** A process's terminal: asked only when its stdin and stderr are both TTYs. */
export function terminalOf(
  stdin: HiddenInput & { isTTY?: boolean },
  stderr: { isTTY?: boolean; write(s: string): unknown },
): TokenTerminal {
  return {
    interactive: () => stdin.isTTY === true && stderr.isTTY === true,
    ask: (question) => askHidden(question, stdin, stderr),
  }
}
