// A `with { type: 'file' }` import of vx's peak-memory helper (`measure/`,
// built by scripts/build-observe.ts): Bun hands back its path.
declare module '*/measure/vx-measure-x64' {
  const path: string
  export default path
}
declare module '*/measure/vx-measure-arm64' {
  const path: string
  export default path
}
