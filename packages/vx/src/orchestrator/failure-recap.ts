// The end of each failed task's output, kept for the run's last lines
// (item 706). A failure's frame prints when the task finishes, which in a
// long CI log is thousands of lines above the end, and GitHub's API returns
// only a job log's last 5,000 lines: the summary is the one place a reader
// reliably looks, so the failure's own words are repeated there.
//
// The capture is a ring over the output's END: it keeps at most
// RECAP_TASK_BYTES characters (and a newline) however much a task prints,
// and counts what it evicts, so the recap can say how much it is not
// showing.

/** Lines of each failed task's output the recap repeats. */
const RECAP_LINES = 30
/** The byte cap on one task's repeated lines. */
const RECAP_TASK_BYTES = 8 * 1024
/**
 * Tasks that get a tail; the rest are named by id. Five tails at the
 * per-task cap is 40 KiB, so the recap stays under 64 KiB with no cap
 * of its own.
 */
export const RECAP_TASKS = 5

export interface RecapRing {
  chunks: string[]
  chars: number
  /** Newlines evicted from the head. */
  cutLines: number
  /** Bytes evicted from the line the kept text starts with; 0 when it starts a line. */
  cutPartialBytes: number
}

export interface RecapTail {
  /** The last lines, at most RECAP_LINES of them and RECAP_TASK_BYTES bytes. */
  text: string
  /** Whole lines above `text`. */
  earlierLines: number
  /** Bytes cut from the start of `text`'s first line. */
  cutBytes: number
}

export function createRecapRing(): RecapRing {
  return { chunks: [], chars: 0, cutLines: 0, cutPartialBytes: 0 }
}

// The ring counts characters, the cap bytes: a UTF-16 unit is at least one
// UTF-8 byte, so the last RECAP_TASK_BYTES characters always hold the last
// RECAP_TASK_BYTES bytes. One more for the final newline the tail drops.
const RING_CHARS = RECAP_TASK_BYTES + 1

export function appendRecapRing(r: RecapRing, chunk: string): void {
  if (chunk.length === 0) return
  r.chunks.push(chunk)
  r.chars += chunk.length
  // A whole chunk goes only when what follows it still fills the ring:
  // evicting past the cap would leave the recap fewer lines than it shows.
  while (r.chunks.length > 1 && r.chars - r.chunks[0]!.length >= RING_CHARS) {
    const gone = r.chunks.shift()!
    r.chars -= gone.length
    evict(r, gone, gone.length)
  }
  if (r.chars > RING_CHARS) {
    const head = r.chunks[0]!
    const at = r.chars - RING_CHARS
    evict(r, head, at)
    r.chunks[0] = head.slice(at)
    r.chars = RING_CHARS
  }
}

function evict(r: RecapRing, s: string, end: number): void {
  const last = s.lastIndexOf('\n', end - 1)
  const partial = Buffer.byteLength(s.slice(last + 1, end))
  if (last < 0) {
    r.cutPartialBytes += partial
    return
  }
  r.cutLines += countNewlines(s, last + 1)
  r.cutPartialBytes = partial
}

function countNewlines(s: string, end: number): number {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1 && i < end; i = s.indexOf('\n', i + 1)) n++
  return n
}

/**
 * The recap's view of what the ring kept: its last RECAP_LINES lines, then
 * its last RECAP_TASK_BYTES bytes (cut on a character boundary). The text
 * is a fresh copy, so it holds nothing of the chunks it came from.
 */
export function recapTail(r: RecapRing): RecapTail {
  const t = r.chunks.join('')
  const end = t.endsWith('\n') ? t.length - 1 : t.length
  let start = 0
  for (let pos = end, taken = 1; ; pos = start - 1, taken++) {
    const nl = pos === 0 ? -1 : t.lastIndexOf('\n', pos - 1)
    if (nl < 0) {
      start = 0
      break
    }
    start = nl + 1
    if (taken === RECAP_LINES) break
  }
  let earlierLines = r.cutLines + countNewlines(t, start)
  let cutBytes = start === 0 ? r.cutPartialBytes : 0
  const bytes = Buffer.from(t.slice(start, end), 'utf8')
  if (bytes.length <= RECAP_TASK_BYTES)
    return { text: bytes.toString('utf8'), earlierLines, cutBytes }
  let at = bytes.length - RECAP_TASK_BYTES
  while ((bytes[at]! & 0xc0) === 0x80) at++
  const lastNl = bytes.lastIndexOf(0x0a, at - 1)
  if (lastNl < 0) cutBytes += at
  else {
    for (let i = bytes.indexOf(0x0a); i !== -1 && i <= lastNl; i = bytes.indexOf(0x0a, i + 1)) {
      earlierLines++
    }
    cutBytes = at - lastNl - 1
  }
  return { text: bytes.subarray(at).toString('utf8'), earlierLines, cutBytes }
}
