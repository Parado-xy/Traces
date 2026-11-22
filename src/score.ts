/**
 * Deterministic, explainable attribute matching for bicycle listings.
 * All weights and conflict caps are visible here so a reviewer can inspect why a
 * listing ranked highly. No score alone authorizes an outward action.
 */
import type { BikeCase, Listing, Evidence, Score } from './domain.ts';

/**
 * Normalizes case and punctuation for whole-phrase object comparisons.
 */
const normalizeText = (value: string) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/**
 * Removes serial-number separators while preserving letters and digits.
 * This intentionally does not perform fuzzy or homoglyph matching.
 */
const normalizeSerial = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const unknownSerial = /^(unknown|absent|none|na|notvisible|hidden|unreadable)$/;
/**
 * Builds the distinct normalized words used to detect empty attribute phrases.
 */
const uniqueWords = (value: string) =>
  new Set(normalizeText(value).split(' ').filter(Boolean));
/**
 * Tests a complete normalized phrase at word boundaries.
 * For example, model FX 3 must not match the longer model token FX 30.
 */
function containsPhrase(haystack: string, needle: string) {
  const normalizedPhrase = normalizeText(needle);
  return (
    !!normalizedPhrase && ` ${normalizeText(haystack)} `.includes(` ${normalizedPhrase} `)
  );
}

/**
 * Excludes absent, short, and common placeholder serial values from matching.
 */
function hasUsableSerial(value: string | null | undefined) {
  return (
    !!value &&
    normalizeSerial(value).length >= 4 &&
    !unknownSerial.test(normalizeText(value).replaceAll(' ', ''))
  );
}

/**
 * Extracts supported color words, treating grey and gray as equivalent.
 * The provider phrase "silver, gray or bare metal" supplies alternatives,
 * not a claim that every listed color must appear on the object.
 */
function extractColorTerms(value: string): string[] {
  return normalizeText(value)
    .replace(/grey/g, 'gray')
    .split(' ')
    .filter((word) =>
      [
        'black',
        'white',
        'red',
        'blue',
        'green',
        'yellow',
        'orange',
        'purple',
        'pink',
        'brown',
        'silver',
        'gray',
        'gold',
        'teal',
      ].includes(word),
    );
}

/**
 * Ranks a listing against one case and explains every attribute contribution.
 * @param bike Case attributes supplying the comparison evidence.
 * @param listing Object snapshot from a case-specific search.
 * @returns A fixed-denominator score, evidence breakdown, and visible conflicts.
 * Missing evidence earns zero; explicit conflicts cap the final ranking score.
 * This pure function performs no storage, network request, or verification.
 */
export function scoreListing(bike: BikeCase, listing: Listing): Score {
  const evidence: Evidence[] = [];
  const conflicts: string[] = [];
  const listingText = `${listing.title} ${listing.description}`;
  const listingAttributes = listing.attributes;
  /**
   * Appends one evidence row so every scoring branch produces the same explanation shape.
   */
  function addEvidence(
    attribute: string,
    points: number,
    possible: number,
    state: Evidence['state'],
    detail: string,
  ) {
    evidence.push({ attribute, points, possible, state, detail });
  }
  // Structured make/model disagreements override words in the description:
  // mentioning a compatible model is weaker than explicitly naming another one.
  for (const [key, weight] of [
    ['make', 20],
    ['model', 25],
  ] as const) {
    const expected = bike[key];
    const actual = listingAttributes[key];
    if (!expected) {
      addEvidence(key, 0, weight, 'missing', 'Case has no value');
    } else if (actual && normalizeText(actual) !== normalizeText(expected)) {
      conflicts.push(`${key}: explicit listing value differs`);
      addEvidence(key, 0, weight, 'conflict', `Case: ${expected}; listing: ${actual}`);
    } else if (
      (actual && normalizeText(actual) === normalizeText(expected)) ||
      containsPhrase(listingText, expected)
    ) {
      addEvidence(
        key,
        weight,
        weight,
        'matched',
        `Found ${expected}${actual ? ' in structured attributes' : ' in listing text'}`,
      );
    } else {
      addEvidence(key, 0, weight, 'not_found', `Not found: ${expected}`);
    }
  }
  // Treat the registry's color labels as alternatives. Prefer explicit listing
  // colors; fall back to text only when structured color information is absent.
  const expectedColors = [...new Set(bike.colors.flatMap(extractColorTerms))];
  const actualColors = (listingAttributes.colors ?? []).flatMap(extractColorTerms);
  const colorMatch = expectedColors.some(
    (color) =>
      actualColors.includes(color) ||
      (!actualColors.length && containsPhrase(listingText, color)),
  );
  const colorConflict =
    expectedColors.length > 0 &&
    actualColors.length > 0 &&
    !expectedColors.some((color) => actualColors.includes(color));
  if (colorConflict) {
    conflicts.push('color: explicit listing color differs');
  }
  addEvidence(
    'color',
    colorMatch && !colorConflict ? 10 : 0,
    10,
    !expectedColors.length
      ? 'missing'
      : colorConflict
        ? 'conflict'
        : colorMatch
          ? 'matched'
          : 'not_found',
    `Case colors: ${bike.colors.join(', ') || 'unknown'}; listing colors: ${(listingAttributes.colors ?? []).join(', ') || 'text only'}`,
  );
  // Credit complete component/marking phrases proportionally. Generic word
  // overlap alone is insufficient evidence for a distinctive object feature.
  for (const [key, weight] of [
    ['components', 10],
    ['markings', 15],
  ] as const) {
    const expected = bike[key];
    const candidate = `${listingText} ${(listingAttributes[key] ?? []).join(' ')}`;
    // Complete phrases only; generic shared words must not count as distinctive evidence.
    const matches = expected.filter(
      (value) => uniqueWords(value).size > 0 && containsPhrase(candidate, value),
    );
    addEvidence(
      key,
      expected.length ? Math.round((weight * matches.length) / expected.length) : 0,
      weight,
      !expected.length ? 'missing' : matches.length ? 'matched' : 'not_found',
      matches.length
        ? `Found: ${matches.join('; ')}`
        : `No complete ${key} phrases found`,
    );
  }
  const serial = hasUsableSerial(bike.serial) ? normalizeSerial(bike.serial!) : '';
  const listingSerial = hasUsableSerial(listingAttributes.serial)
    ? normalizeSerial(listingAttributes.serial!)
    : '';
  // Serial matching requires an explicitly transcribed attribute, never the whole text
  // with separators stripped (which can join unrelated words into a false serial).
  if (serial && listingSerial && serial !== listingSerial) {
    conflicts.push('serial: explicit serial differs');
    addEvidence('serial', 0, 20, 'conflict', 'Explicit serial mismatch');
  } else {
    addEvidence(
      'serial',
      serial && listingSerial === serial ? 20 : 0,
      20,
      !serial ? 'missing' : listingSerial === serial ? 'matched' : 'not_found',
      !serial
        ? 'Case serial unavailable'
        : listingSerial === serial
          ? 'Exact normalized serial match'
          : 'No explicit matching serial',
    );
  }
  let total = evidence.reduce((totalPoints, entry) => totalPoints + entry.points, 0);
  // These are ranking points, not probabilities; conflicts are always visible.
  if (conflicts.some((conflict) => conflict.startsWith('serial:'))) {
    total = Math.min(total, 10);
  } else if (conflicts.length) {
    total = Math.min(total, 35);
  }
  return { version: 'text-v1', total, evidence, conflicts };
}

/**
 * Builds the bounded make/model/bicycle query used by search adapters.
 * @throws If the case lacks both make and model; broad case-free searches are rejected.
 */
export function caseQuery(bike: BikeCase): string {
  const query = [bike.make, bike.model, 'bicycle'].filter(Boolean).join(' ').trim();
  if (!bike.make && !bike.model) {
    throw new Error('Case needs a make or model for case-led search');
  }
  return query.slice(0, 100);
}
