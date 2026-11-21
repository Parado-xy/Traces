import type { BikeCase, Listing, Evidence, Score } from './domain.ts';

const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const serialNorm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const unknownSerial = /^(unknown|absent|none|na|notvisible|hidden|unreadable)$/;
const words = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
function phrase(haystack: string, needle: string) {
  const n = norm(needle);
  return !!n && (` ${norm(haystack)} `).includes(` ${n} `);
}
function usableSerial(s: string | null | undefined) {
  return !!s && serialNorm(s).length >= 4 && !unknownSerial.test(norm(s).replaceAll(' ', ''));
}
function colorTerms(s: string): string[] {
  return norm(s).replace(/grey/g, 'gray').split(' ').filter(w =>
    ['black','white','red','blue','green','yellow','orange','purple','pink','brown','silver','gray','gold','teal'].includes(w));
}

export function scoreListing(bike: BikeCase, listing: Listing): Score {
  const evidence: Evidence[] = [];
  const conflicts: string[] = [];
  const blob = `${listing.title} ${listing.description}`;
  const attr = listing.attributes;
  function add(attribute: string, points: number, possible: number, state: Evidence['state'], detail: string) {
    evidence.push({attribute, points, possible, state, detail});
  }
  for (const [key, weight] of [['make', 20], ['model', 25]] as const) {
    const expected = bike[key]; const actual = attr[key];
    if (!expected) add(key, 0, weight, 'missing', 'Case has no value');
    else if (actual && norm(actual) !== norm(expected)) {
      conflicts.push(`${key}: explicit listing value differs`);
      add(key, 0, weight, 'conflict', `Case: ${expected}; listing: ${actual}`);
    } else if ((actual && norm(actual) === norm(expected)) || phrase(blob, expected)) {
      add(key, weight, weight, 'matched', `Found ${expected}${actual ? ' in structured attributes' : ' in listing text'}`);
    } else add(key, 0, weight, 'not_found', `Not found: ${expected}`);
  }
  const expectedColors = [...new Set(bike.colors.flatMap(colorTerms))];
  const actualColors = (attr.colors ?? []).flatMap(colorTerms);
  const colorMatch = expectedColors.some(c => actualColors.includes(c) || (!actualColors.length && phrase(blob, c)));
  const colorConflict = expectedColors.length > 0 && actualColors.length > 0 && !expectedColors.some(c => actualColors.includes(c));
  if (colorConflict) conflicts.push('color: explicit listing color differs');
  add('color', colorMatch && !colorConflict ? 10 : 0, 10,
    !expectedColors.length ? 'missing' : colorConflict ? 'conflict' : colorMatch ? 'matched' : 'not_found',
    `Case colors: ${bike.colors.join(', ') || 'unknown'}; listing colors: ${(attr.colors ?? []).join(', ') || 'text only'}`);
  for (const [key, weight] of [['components',10], ['markings',15]] as const) {
    const expected = bike[key];
    const candidate = `${blob} ${(attr[key] ?? []).join(' ')}`;
    // Complete phrases only; generic shared words must not count as distinctive evidence.
    const matches = expected.filter(v => words(v).size > 0 && phrase(candidate, v));
    add(key, expected.length ? Math.round(weight * matches.length / expected.length) : 0,
      weight, !expected.length ? 'missing' : matches.length ? 'matched' : 'not_found',
      matches.length ? `Found: ${matches.join('; ')}` : `No complete ${key} phrases found`);
  }
  const serial = usableSerial(bike.serial) ? serialNorm(bike.serial!) : '';
  const listingSerial = usableSerial(attr.serial) ? serialNorm(attr.serial!) : '';
  // Serial matching requires an explicitly transcribed attribute, never the whole text
  // with separators stripped (which can join unrelated words into a false serial).
  if (serial && listingSerial && serial !== listingSerial) {
    conflicts.push('serial: explicit serial differs');
    add('serial', 0, 20, 'conflict', 'Explicit serial mismatch');
  } else add('serial', serial && listingSerial === serial ? 20 : 0, 20,
    !serial ? 'missing' : listingSerial === serial ? 'matched' : 'not_found',
    !serial ? 'Case serial unavailable' : listingSerial === serial ? 'Exact normalized serial match' : 'No explicit matching serial');
  let total = evidence.reduce((n, e) => n + e.points, 0);
  // These are ranking points, not probabilities; conflicts are always visible.
  if (conflicts.some(c => c.startsWith('serial:'))) total = Math.min(total, 10);
  else if (conflicts.length) total = Math.min(total, 35);
  return {version:'text-v1', total, evidence, conflicts};
}

export function caseQuery(bike: BikeCase): string {
  const q = [bike.make, bike.model, 'bicycle'].filter(Boolean).join(' ').trim();
  if (!bike.make && !bike.model) throw new Error('Case needs a make or model for case-led search');
  return q.slice(0,100);
}
