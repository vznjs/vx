// The one sentinel both halves read, in its own module so the worker does not
// have to import the plugin (which imports the worker) to see it.

/** Set by a worker on itself: the plugin declines inside one, so an assignment
 *  cannot be dispatched back to the synchronizer that sent it. */
export const WORKER_ENV = 'VX_AGENTS_WORKER'
