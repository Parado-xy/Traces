/**
 * Demonstrates the complete local workflow with synthetic, labeled records.
 * The database lives in memory and is always closed; no API request or outward
 * notification is made. The scripted verdict demonstrates mechanics only.
 */
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.ts';
import { parseListing } from '../src/domain.ts';
import { benchmark } from '../src/benchmark.ts';
import { notificationDraft } from '../src/notify.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/benchmark.json', import.meta.url), 'utf8'),
);
const store = new Store(':memory:');
try {
  // Seed one case and run its synthetic listings through the production scorer.
  store.putCase(fixture.bike);
  const run = store.startRun(fixture.bike.id, 'staged', 'Trek FX 3 bicycle');
  const ids = store.finishRun(
    run,
    fixture.bike,
    fixture.items.map((i: any) => parseListing(i.listing, 'staged')),
  );
  // Deliberately label the actor as a script so this cannot be mistaken for
  // evidence of a human-verified recovery when inspecting the demonstration.
  store.review(
    ids[0],
    'match',
    'DEMO SCRIPT, not a human',
    'Synthetic example verdict to exercise the gate',
  );
  // Even after a match verdict, staged evidence must fail the notification gate.
  // Draft generation is sufficient to test this without making a network call.
  let gate = '';
  try {
    notificationDraft(store, ids[0]);
  } catch (e) {
    gate = (e as Error).message;
  }
  // Report synthetic evaluation separately from the empty real-case metrics.
  console.log(
    JSON.stringify(
      {
        mode: 'synthetic, no network, in-memory database',
        queue: store.observations(),
        notificationGate: gate,
        benchmark: benchmark(fixture),
        realMetrics: store.metrics(),
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
