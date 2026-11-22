/**
 * Operator-facing integration runner. All commands are explicit and JSON-based.
 * It intentionally has no --send option: inspecting a live-test setup must not
 * trigger an owner notification. Actual sends remain in the existing gated CLI.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../store.ts';
import { integrationConfig, integrationStatus } from './config.ts';
import { checkBikeIndexRead, checkEbaySearch, checkNotification } from './checks.ts';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    region: { type: 'string' },
    distance: { type: 'string' },
    limit: { type: 'string' },
    case: { type: 'string' },
    id: { type: 'string' },
    'expect-item': { type: 'string' },
    help: { type: 'boolean' },
  },
});
const help = `Traces integration checks (no command sends notifications)
  status
  bikeindex-read [--region "Grambling, LA" --distance 100 --limit 1]
  ebay-search [--case CASE_ID] [--expect-item EXACT_EBAY_ITEM_ID]
  notification-check --id OBSERVATION_ID
All data commands use data/integration.sqlite by default; override with --db.
Sandbox eBay search without --case uses the synthetic text fixture.
To inspect the resulting records: npm run review -- --db data/integration.sqlite
`;
const command = positionals[0];
let store: Store | undefined;
try {
  if (values.help || !command) {
    console.log(help);
  } else {
    if (positionals.length !== 1) {
      throw new Error('Choose exactly one integration check.');
    }
    const config = integrationConfig();
    let result: unknown;
    if (command === 'status') {
      result = integrationStatus(config);
    } else {
      if (!['bikeindex-read', 'ebay-search', 'notification-check'].includes(command)) {
        throw new Error('Unknown integration command. Use --help.');
      }
      store = new Store(resolve(values.db || 'data/integration.sqlite'));
      store.purge(Number(process.env.RETENTION_DAYS || 30));
      switch (command) {
        case 'bikeindex-read':
          result = await checkBikeIndexRead(
            store,
            config,
            values.region || 'Grambling, LA',
            Number(values.distance || 100),
            Number(values.limit || 1),
          );
          break;
        case 'ebay-search':
          result = await checkEbaySearch(
            store,
            config,
            values.case,
            values['expect-item'],
          );
          // An explicit known-item assertion is a test expectation, not merely
          // an informational count. Report a failed assertion with a nonzero exit.
          if ((result as { knownItemFound: boolean | null }).knownItemFound === false) {
            process.exitCode = 1;
          }
          break;
        case 'notification-check': {
          const id = Number(values.id);
          if (!Number.isSafeInteger(id) || id < 1) {
            throw new Error('notification-check requires a positive --id.');
          }
          result = await checkNotification(store, config, id);
          break;
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : 'Integration check failed.',
    }),
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
