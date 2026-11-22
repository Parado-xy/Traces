/**
 * Seeds an isolated practice database for exercising the review interface.
 * All records are synthetic. The drawings are illustrations, not photographs or
 * a ground-truth image benchmark. No provider request or notification is made.
 */
import { readFileSync } from 'node:fs';
import type { BikeCase } from '../domain.ts';
import { parseListing } from '../domain.ts';
import { Store } from '../store.ts';

/**
 * Creates open, changed, and closed cases so important review states are visible.
 * @param store An empty, practice-only database owned by the review launcher.
 * @param origin The local server origin used for illustrative sample images.
 */
export function seedPracticeWorkspace(store: Store, origin: string) {
  if (store.cases().length) {
    throw new Error('Practice seeding requires an empty store.');
  }
  const fixture = JSON.parse(
    readFileSync(new URL('../../fixtures/benchmark.json', import.meta.url), 'utf8'),
  );
  const bike: BikeCase = {
    ...fixture.bike,
    photos: [`${origin}/assets/demo-report.svg`, `${origin}/assets/demo-listing.svg`],
    stolenLocation: 'Practice workspace',
    fetchedAt: new Date().toISOString(),
  };
  store.putCase(bike);

  // Seed a repeated snapshot to make the provenance/history selector testable.
  // There is no scripted human verdict: the operator supplies the first review.
  const olderRun = store.startRun(bike.id, 'staged', 'Trek FX 3 bicycle');
  const listings = fixture.items.map((item: any) =>
    parseListing(
      {
        ...item.listing,
        photos: [`${origin}/assets/demo-listing.svg`, `${origin}/assets/demo-report.svg`],
      },
      'staged',
    ),
  );
  store.finishRun(olderRun, bike, [listings[0]]);
  const run = store.startRun(bike.id, 'staged', 'Trek FX 3 bicycle');
  store.finishRun(run, bike, listings);

  // A changed case must still show its earlier evidence but block new verdicts.
  const changed = { ...bike, id: 'staged:changed-case', model: 'FX 2' };
  store.putCase(changed);
  const changedRun = store.startRun(changed.id, 'staged', 'Trek FX 2 bicycle');
  store.finishRun(changedRun, changed, [listings[0]]);
  store.putCase({ ...changed, model: 'FX 4' });

  const closed = { ...bike, id: 'staged:closed-case', model: 'Marlin 5' };
  store.putCase(closed);
  const closedRun = store.startRun(closed.id, 'staged', 'Trek Marlin 5 bicycle');
  store.finishRun(closedRun, closed, [listings[0]]);
  store.putCase({ ...closed, status: 'closed' });
}
