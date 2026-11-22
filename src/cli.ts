/**
 * Command-line entry point wiring the case, search, review, and reporting layers.
 * Commands produce JSON for inspection or scripting. Opening a store enforces
 * retention; sending requires an explicit --send and an approved app setup.
 * The CLI handles configuration and command dispatch, not matching policy.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Store, fingerprint } from './store.ts';
import { BikeIndex, normalizeBike } from './adapters/bikeindex.ts';
import { Ebay } from './adapters/ebay.ts';
import { parseListing } from './domain.ts';
import type { Verdict } from './domain.ts';
import { caseQuery } from './score.ts';
import { integrationConfig } from './integration/config.ts';
import { benchmark } from './benchmark.ts';
import { notificationDraft, sendNotification } from './notify.ts';

// Load local credentials before selecting command defaults. Actual credentials
// stay outside version control and are never printed with command results.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    case: { type: 'string' },
    region: { type: 'string' },
    distance: { type: 'string' },
    limit: { type: 'string' },
    file: { type: 'string' },
    id: { type: 'string' },
    source: { type: 'string' },
    verdict: { type: 'string' },
    reviewer: { type: 'string' },
    notes: { type: 'string' },
    query: { type: 'string' },
    method: { type: 'string' },
    minutes: { type: 'string' },
    threshold: { type: 'string' },
    days: { type: 'string' },
    send: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const help = `Traces: bicycle case-led matching MVP (Node 24+)
Commands (all output is JSON; all accept --db PATH):
  init
  ingest --region "Grambling, LA" --distance 100 --limit 3
  refresh --case bikeindex:123
  import-case --file bikeindex-response.json
  cases
  show --case bikeindex:123
  search --case bikeindex:123 --source ebay
  import-listings --case bikeindex:123 --file listings.json --query "actual search terms used"
  queue [--case bikeindex:123]
  review --id 1 --verdict match|not_match|unsure --reviewer Jalla --notes "Evidence checked..."
  time --case bikeindex:123 --method manual|assisted --minutes 6.5
  metrics [--case bikeindex:123]
  benchmark --file fixtures/benchmark.json [--threshold 50]
  notify --id 1                  # local draft only
  notify --id 1 --send           # explicit outward action, requires approved Bike Index app
  audit
  purge [--days 30]
Use npm run demo for an isolated synthetic demonstration. No notification is sent by demo.
Manual imports must contain object information only; omit names, contact details, and seller profiles.
`;
const command = positionals[0];
if (options.help || !command) {
  console.log(help);
  process.exit(0);
}

/**
 * Reads a required string option and rejects missing or blank values.
 * @param key The parsed CLI option name used in the validation message.
 */
const requiredOption = (key: keyof typeof options) => {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${key} is required`);
  }
  return value;
};

/**
 * Reads a finite numeric option or an explicit default.
 * Domain-specific bounds are checked by the operation receiving this number.
 */
const numericOption = (key: keyof typeof options, fallback?: number) => {
  const value = options[key] === undefined ? fallback : Number(requiredOption(key));
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`--${key} must be numeric`);
  }
  return value;
};

/**
 * Loads the operator-selected JSON file.
 * The receiving command validates its schema before storing any records.
 */
const readJsonFile = () => JSON.parse(readFileSync(requiredOption('file'), 'utf8'));
let store: Store | undefined;
try {
  if (positionals.length > 1) {
    throw new Error('Unexpected positional arguments');
  }
  // Benchmark evaluation needs no persistent database or external API access.
  if (command === 'benchmark') {
    console.log(
      JSON.stringify(benchmark(readJsonFile(), numericOption('threshold', 50)), null, 2),
    );
  } else {
    store = new Store(
      resolve(options.db || process.env.TRACE_DB || 'data/trace-shadow.sqlite'),
    );
    // Retention is enforced whenever the CLI opens a store. No background daemon.
    const days = Number(process.env.RETENTION_DAYS || 30);
    store.purge(days);
    let output: unknown;
    switch (command) {
      case 'init':
        output = { initialized: true, schemaVersion: 1, retentionDays: days };
        break;
      case 'ingest': {
        const bikes = await new BikeIndex(process.env.BIKEINDEX_TOKEN).search(
          options.region || 'Grambling, LA',
          numericOption('distance', 100),
          numericOption('limit', 3),
        );
        for (const bike of bikes) {
          store.putCase(bike);
        }
        output = {
          ingested: bikes.length,
          cases: bikes.map((b) => ({
            id: b.id,
            make: b.make,
            model: b.model,
            stolenLocation: b.stolenLocation,
          })),
        };
        break;
      }
      case 'refresh': {
        const bike = store.getCase(requiredOption('case'));
        if (!bike.bikeIndexId) {
          throw new Error('Staged case cannot refresh from Bike Index');
        }
        const current = await new BikeIndex(process.env.BIKEINDEX_TOKEN).get(
          bike.bikeIndexId,
        );
        store.putCase(current);
        output = current;
        break;
      }
      case 'import-case': {
        const raw = readJsonFile();
        const bike = normalizeBike(raw.bike ?? raw);
        store.putCase(bike);
        output = bike;
        break;
      }
      case 'cases':
        output = store.cases();
        break;
      case 'show':
        output = store.getCase(requiredOption('case'));
        break;
      case 'search': {
        // Persist the attempt before calling the adapter so provider failures
        // remain visible rather than looking like completed empty searches.
        if (requiredOption('source') !== 'ebay') {
          throw new Error(
            'Only eBay automation is implemented; use manual object-only imports for other sources',
          );
        }
        const bike = store.openCase(requiredOption('case'));
        const adapter = new Ebay(integrationConfig().ebay);
        const environment = adapter.config.environment;
        const run = store.startRun(bike.id, `ebay:${environment}`, caseQuery(bike));
        try {
          const result = await adapter.search(bike);
          output = {
            runId: run,
            observations: store.finishRun(run, bike, result.listings),
          };
        } catch (error) {
          store.failRun(run);
          throw error;
        }
        break;
      }
      case 'import-listings': {
        // A manual import records the query the operator actually used.
        // Pasting a URL does not cause this command to fetch or scrape it.
        const bike = store.openCase(requiredOption('case'));
        const raw = readJsonFile();
        if (!Array.isArray(raw) || raw.length > 100) {
          throw new Error('Expected an array of at most 100 case-specific listings');
        }
        const listings = raw.map((x) =>
          parseListing(x, bike.staged ? 'staged' : 'manual'),
        );
        const run = store.startRun(
          bike.id,
          'manual',
          requiredOption('query').slice(0, 500),
        );
        try {
          output = { runId: run, observations: store.finishRun(run, bike, listings) };
        } catch (error) {
          store.failRun(run);
          throw error;
        }
        break;
      }
      case 'queue': {
        const activeStore = store;
        output = store.observations(options.case).map((observation) => ({
          ...observation,
          caseStatus: activeStore.getCase(observation.caseId).status,
          caseChanged:
            observation.caseFingerprint !==
            fingerprint(activeStore.getCase(observation.caseId)),
          leadOnly: true,
        }));
        break;
      }
      case 'review':
        store.review(
          numericOption('id'),
          requiredOption('verdict') as Verdict,
          requiredOption('reviewer'),
          requiredOption('notes'),
        );
        output = { recorded: true, observationId: numericOption('id') };
        break;
      case 'time':
        store.time(
          requiredOption('case'),
          requiredOption('method'),
          numericOption('minutes'),
        );
        output = { recorded: true };
        break;
      case 'metrics':
        if (options.case) {
          store.getCase(options.case);
        }
        output = store.metrics(options.case);
        break;
      case 'notify': {
        // Drafting stays local. Only explicit --send plus configured approval
        // can enter the sender's additional evidence and delivery checks.
        if (options.send) {
          if (process.env.BIKEINDEX_NOTIFY_APPROVED !== 'true') {
            throw new Error(
              'Sending disabled: approved Bike Index application or an authorized own-bike test required; set BIKEINDEX_NOTIFY_APPROVED=true only after that setup',
            );
          }
          output = await sendNotification(
            store,
            numericOption('id'),
            process.env.BIKEINDEX_TOKEN || '',
          );
        } else {
          output = { sent: false, draft: notificationDraft(store, numericOption('id')) };
        }
        break;
      }
      case 'audit':
        output = store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all();
        break;
      case 'purge':
        output = store.purge(numericOption('days', days));
        break;
      default:
        throw new Error(`Unknown command: ${command}. Use --help`);
    }
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : 'Unexpected failure',
    }),
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
