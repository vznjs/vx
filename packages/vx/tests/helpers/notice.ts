// What a refusal line prints as its notice, plain: tests state the
// refusal's words and let the component lay them out (tests/ui.test.ts
// and tests/refusal-notice.test.ts hold the layout itself).
import { lineNotice } from '../../src/util/refusal-notice.js'
import { render, type Tone } from '../../src/util/ui.js'

/** `vx run: …` lines (each may carry indented lines under it) as notices. */
export function noticed(text: string, tone: Tone = 'error'): string {
  const groups: string[] = []
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (groups.length === 0 || !line.startsWith(' ')) groups.push(line)
    else groups[groups.length - 1] += `\n${line}`
  }
  return groups
    .map((g) => {
      // A verb may be several words (`vx cache clean: …`); vx passes those itself.
      const named = /^(vx(?: [\w-]+)*?): /.exec(g)
      const line = named === null ? g : g.slice(named[0].length)
      return render([lineNotice(tone, line, named?.[1])], { enabled: false })
    })
    .join('')
}
