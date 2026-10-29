/**
 * The root manifest's `engines`, compacted, printed by one `awk` at the
 * workspace root: Turbo folds that value into every task's global hash
 * (crates/turborepo-task-hash/src/global_hash.rs), so raising
 * `engines.node` re-ran every task under `turbo run` and replayed a hit
 * under vx. A probe reads it live, so `turbo()` and the config the
 * migration writes key it alike; it prints only the `engines` value, so
 * no other root edit re-keys a task. A top-level JSON scanner, strings
 * and escapes skipped, whitespace outside strings dropped: a reformat
 * keys alike, a reorder misses (never a stale hit). One process, no Node.
 */
export const ROOT_ENGINES_PROBE =
  'LC_ALL=C awk \'BEGIN{RS="\\001"}{n=length($0);d=0;q=0;c=0;o="";for(i=1;i<=n;i++){x=substr($0,i,1);if(c&&(q||x!~/[ \\t\\r\\n]/))o=o x;if(q){if(x=="\\\\"){i++;if(c)o=o substr($0,i,1)}else if(x=="\\""){q=0;if(d==1&&!c)k=substr($0,s,i-s)}continue}if(x=="\\""){q=1;s=i+1}else if(x=="{"||x=="[")d++;else if(x=="}"||x=="]"){d--;if(c&&d==1){print o;exit}}else if(x==":"&&d==1&&!c&&k=="engines")c=1}}\' package.json'

/** Whether Turbo hashes the root's `engines`: a non-empty object, as it reads one. */
export function keysRootEngines(rootPackageJson: unknown): boolean {
  const engines = (rootPackageJson as { engines?: unknown } | null)?.engines
  return typeof engines === 'object' && engines !== null && Object.keys(engines).length > 0
}
