/** One nightly row: vx's best time against the rival's, in ms. */
export interface Matchup {
  tool: string
  vx: number
  rival: number
}

// "N× faster" from 2×, a percentage below it (2026-10-09). Both round
// down: a 2.96× win reads 2.9×, a 9.9% win 9%, never more than measured.
export function verdict(r: Matchup): string {
  const [fast, slow] = r.vx <= r.rival ? [r.vx, r.rival] : [r.rival, r.vx]
  // Divide last: (slow / fast - 1) * 100 lands on 56.99… for a 57% win.
  const size =
    slow >= 2 * fast
      ? `${(Math.floor((slow * 10) / fast) / 10).toFixed(1)}×`
      : `${Math.floor(((slow - fast) * 100) / fast)}%`
  return r.vx <= r.rival ? `${size} faster` : `LOSS: ${r.tool} ${size} faster`
}
