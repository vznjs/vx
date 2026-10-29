// A secret asked for on the terminal: hidden, one line, only where someone can answer.

/** Where a missing secret is asked for. */
export interface SecretTerminal {
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
 * Read one line from a raw-mode terminal, echoing nothing; backspace edits.
 * Ctrl-D answers nothing. Raw mode delivers no SIGINT, so Ctrl-C answers
 * nothing and raises it: the run stops as it would at any other moment.
 */
function askHidden(
  question: string,
  input: HiddenInput,
  output: { write(s: string): unknown },
  interrupt: () => void,
): Promise<string> {
  const wasRaw = input.isRaw === true
  // A terminal that refuses raw mode (EIO once its session is gone) cannot
  // hide an answer: the rejection reaches the broker before any question.
  try {
    input.setRawMode(true)
  } catch (err) {
    return Promise.reject(err)
  }
  output.write(question)
  input.resume()
  return new Promise((resolve) => {
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
          resolve('')
          if (ch === '\u0003') interrupt()
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
  interrupt: () => void = () => process.kill(process.pid, 'SIGINT'),
): SecretTerminal {
  return {
    interactive: () => stdin.isTTY === true && stderr.isTTY === true,
    ask: (question) => askHidden(question, stdin, stderr, interrupt),
  }
}
