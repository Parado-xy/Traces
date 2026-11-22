/**
 * Labeled, staged evaluation of the text matcher at a chosen threshold.
 * These rates describe only the supplied labeled pool, not real-world recovery
 * performance or retrieval misses outside that pool.
 */
import type { BikeCase } from './domain.ts';
import { parseListing } from './domain.ts';
import { scoreListing } from './score.ts';

/**
 * Scores labeled staged items and computes their confusion matrix.
 * @param input A staged bike and listings with boolean isMatch ground-truth labels.
 * @param threshold Minimum ranking points counted as a surfaced candidate.
 * @returns TP/FP/TN/FN, precision, FPR, miss rate, and per-item outcomes.
 * @throws For invalid thresholds, non-staged cases, or missing labels.
 * No candidates are persisted and no outward actions occur.
 */
export function benchmark(input: any, threshold = 50) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('Threshold must be 0..100');
  }
  if (!input?.bike?.staged || !Array.isArray(input.items)) {
    throw new Error('Benchmark requires a staged case and labeled items');
  }
  const bike = input.bike as BikeCase;
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  const results = input.items.map((item: any) => {
    if (typeof item.isMatch !== 'boolean') {
      throw new Error('Every benchmark item needs a boolean ground-truth label');
    }
    const listing = parseListing(item.listing, 'staged');
    const score = scoreListing(bike, listing);
    const surfaced = score.total >= threshold;
    if (surfaced && item.isMatch) {
      tp++;
    } else if (surfaced) {
      fp++;
    } else if (item.isMatch) {
      fn++;
    } else {
      tn++;
    }
    return {
      sourceId: listing.sourceId,
      score: score.total,
      surfaced,
      isMatch: item.isMatch,
    };
  });
  /**
   * Computes a metric only when its denominator exists; no data is not a zero rate.
   */
  const rate = (a: number, b: number) => (b ? a / b : null);
  return {
    dataset: input.name ?? 'unnamed',
    warning:
      'Synthetic text fixture checks mechanics only; not evidence of real recovery or image-matching performance.',
    threshold,
    tp,
    fp,
    tn,
    fn,
    precision: rate(tp, tp + fp),
    falsePositiveRate: rate(fp, fp + tn),
    missRate: rate(fn, fn + tp),
    results,
  };
}
