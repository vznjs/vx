// The per-task log capture primitive MOVED INTO CORE (`@vzn/vx`), re-exported
// here so cloud's call sites keep one import path.
//
// It was cloud-local while cloud was its only consumer. The OTLP logs exporter
// in `@vzn/vx-otel` needs the identical bounds and the identical retention
// rules — a hit's bytes belong to the run that executed, failures are never
// evicted to keep a success — and a second implementation of those rules is
// how two sinks come to disagree about which task's output survived. So the
// buffer lives beside the telemetry contract that decides its vocabulary, and
// every sink imports the same one.

export {
  LOG_WIRE_VERSION,
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  TaskLogBuffer,
  type TaskLogBundle,
  type TaskLogEntry,
} from '@vzn/vx'
