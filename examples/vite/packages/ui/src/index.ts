export function badge(label: string, count: number): string {
  return count === 0 ? label : `${label} (${count})`
}
