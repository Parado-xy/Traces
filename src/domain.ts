/**
 * Shared object records and input-normalization helpers.
 * Adapters convert provider data into these schemas before scoring or storage;
 * seller identities and arbitrary provider fields are not part of the contract.
 */
/**
 * A stolen-bike report normalized for case-led object matching.
 * The staged flag separates test cases from real reports and blocks notification.
 */
export type BikeCase = {
  id: string;
  bikeIndexId: number | null;
  status: 'open' | 'closed';
  staged: boolean;
  make: string;
  model: string;
  colors: string[];
  serial: string | null;
  components: string[];
  markings: string[];
  description: string;
  photos: string[];
  stolenLocation: string;
  stolenAt: string | null;
  reportUrl: string | null;
  fetchedAt: string;
};

/**
 * An object-only listing snapshot, including provenance and test-environment flags.
 * Image URLs are references for human inspection; images are not downloaded here.
 */
export type Listing = {
  source: 'ebay' | 'manual' | 'staged';
  sourceId: string;
  url: string;
  testData: boolean;
  environment: 'sandbox' | 'production' | null;
  title: string;
  description: string;
  photos: string[];
  attributes: {
    make?: string;
    model?: string;
    colors?: string[];
    serial?: string;
    components?: string[];
    markings?: string[];
  };
  price: string | null;
  location: string | null;
  postedAt: string | null;
  capturedAt: string;
};

/**
 * One attribute contribution, including missing evidence and explicit conflicts.
 * Possible points stay fixed even when a case or listing omits the attribute.
 */
export type Evidence = {
  attribute: string;
  points: number;
  possible: number;
  state: 'matched' | 'missing' | 'not_found' | 'conflict';
  detail: string;
};

/**
 * Versioned ranking evidence. Total is a heuristic score, not a probability.
 * Conflict caps can make total lower than the sum of positive evidence points.
 */
export type Score = {
  version: string;
  total: number;
  evidence: Evidence[];
  conflicts: string[];
};

/**
 * A human assessment of one observation; unsure does not authorize notification.
 */
export type Verdict = 'match' | 'not_match' | 'unsure';
/**
 * Boundary for a bounded search associated with one existing bicycle case.
 * The returned query is retained alongside the candidates for provenance.
 */
export type SearchAdapter = {
  source: string;
  search(bike: BikeCase): Promise<{ query: string; listings: Listing[] }>;
};

/**
 * Trims and bounds an optional string without converting arbitrary objects.
 * @param value Untrusted provider or operator input.
 * @param max Maximum retained character count.
 * @returns A trimmed string, or an empty string for non-string input.
 */
export function text(value: unknown, max = 5000): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

/**
 * Normalizes a bounded list of optional text values.
 * Non-string and empty entries are omitted; at most 100 values are retained.
 */
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((v) => text(v))
        .filter(Boolean)
        .slice(0, 100)
    : [];
}

/**
 * Validates a web reference without requesting its contents.
 * Rejects non-HTTP protocols and embedded credentials, and removes fragments.
 * @throws If the input is not an acceptable HTTP(S) URL.
 * This checks URL structure, not whether a host is publicly routable.
 */
export function httpUrl(value: unknown): string {
  const u = new URL(text(value));
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('Expected a public HTTP(S) URL');
  }
  u.hash = '';
  return u.toString();
}

/**
 * Converts provider Unix seconds or a date string into a UTC ISO timestamp.
 * @returns Null when the value is absent or cannot be parsed.
 */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const d = new Date(typeof value === 'number' ? value * 1000 : String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Whitelist object fields: seller identities and arbitrary payloads are never stored.
/**
 * Copies only supported object fields from an untrusted listing.
 * @param raw A provider summary or manually entered object record.
 * @param source The trusted caller-selected source, not a field copied from raw.
 * @returns A fresh snapshot timestamped at normalization/import time.
 * @throws If the title or URL is invalid. Does not fetch the URL.
 * Structured seller fields are dropped; free text is not automatically redacted.
 */
export function parseListing(raw: any, source: Listing['source'] = 'manual'): Listing {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Listing must be an object');
  }
  const url = httpUrl(raw.url);
  const title = text(raw.title, 500);
  if (!title) {
    throw new Error('Listing title is required');
  }
  const a = raw.attributes ?? {};
  return {
    source,
    testData: source === 'staged',
    environment: null,
    sourceId: text(raw.sourceId, 300) || url,
    url,
    title,
    description: text(raw.description),
    photos: strings(raw.photos).map(httpUrl),
    attributes: {
      make: text(a.make),
      model: text(a.model),
      colors: strings(a.colors),
      serial: text(a.serial),
      components: strings(a.components),
      markings: strings(a.markings),
    },
    price: text(raw.price, 100) || null,
    location: text(raw.location, 300) || null,
    postedAt: iso(raw.postedAt),
    capturedAt: new Date().toISOString(),
  };
}
