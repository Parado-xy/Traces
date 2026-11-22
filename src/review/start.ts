/**
 * Starts the loopback-only review workspace and owns its database lifetime.
 * Real mode uses the same database path as the CLI. Practice mode instead uses
 * an isolated in-memory database, even when TRACE_DB is set in the environment.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../store.ts';
import { ReviewService } from './service.ts';
import { createReviewServer } from './server.ts';
import { seedPracticeWorkspace } from './demo.ts';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const { values } = parseArgs({
  options: {
    practice: { type: 'boolean', default: false },
    db: { type: 'string' },
    port: { type: 'string' },
    // Local preview runners use Vite-compatible flags. Node already fails on a
    // busy port; accepting strictPort does not change that behavior.
    host: { type: 'string', default: '127.0.0.1' },
    strictPort: { type: 'boolean', default: true },
  },
});
if (!['127.0.0.1', 'localhost'].includes(values.host)) {
  throw new Error('The review workspace must bind a loopback host.');
}
const port = Number(values.port || process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Choose a port from 1 through 65535.');
}
if (values.practice && values.db) {
  throw new Error('Practice mode uses an isolated in-memory store; omit --db.');
}

const store = new Store(
  values.practice
    ? ':memory:'
    : resolve(values.db || process.env.TRACE_DB || 'data/trace-shadow.sqlite'),
);
store.purge(Number(process.env.RETENTION_DAYS || 30));
const service = new ReviewService(store, undefined, values.practice);
const server = createReviewServer({
  service,
  previewOrigin: process.env.TRACES_REVIEW_PREVIEW_ORIGIN,
});

// Bind only loopback. This workspace has no user accounts and should not listen
// on the LAN or be deployed publicly as if it were a hosted application.
server.listen(port, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${port}`;
  if (values.practice) {
    seedPracticeWorkspace(store, origin);
  }
  console.log(`Traces review workspace: ${origin}`);
  console.log(
    values.practice
      ? 'Practice data only; changes disappear on exit.'
      : 'Using the shared local case database.',
  );
});
server.on('close', () => store.close());
server.on('error', (error) => {
  console.error(`Unable to start review workspace: ${error.message}`);
  store.close();
  process.exitCode = 1;
});

/** Stops accepting requests and releases keep-alive connections before closing SQLite. */
function shutdown() {
  server.close();
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
