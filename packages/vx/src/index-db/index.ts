// Module contract. cache.db: one schema, shared by the store (cache), the
// memos (memo) and the run history (history). Below all three, so none of
// them reaches another for the tables they share.
export {
  closeDb,
  createArtifactTables,
  createTables,
  EXECUTED_RUNS_SQL,
  inHashes,
  isIndexFull,
  KEYED_RUNS_SQL,
  lazyStatement,
  pruneHistoryRows,
  RUNS_VIEW,
  SCHEMA_VERSION,
  SQLITE_FCNTL_PERSIST_WAL,
  unreadableIndex,
} from './schema.js'
