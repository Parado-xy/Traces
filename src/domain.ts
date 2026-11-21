export type BikeCase = {
  id: string; bikeIndexId: number | null; status: 'open' | 'closed'; staged: boolean;
  make: string; model: string; colors: string[]; serial: string | null;
  components: string[]; markings: string[]; description: string;
  photos: string[]; stolenLocation: string; stolenAt: string | null;
  reportUrl: string | null; fetchedAt: string;
};
export type Listing = {
  source: 'ebay' | 'manual' | 'staged'; sourceId: string; url: string;
  testData:boolean; environment:'sandbox'|'production'|null;
  title: string; description: string; photos: string[];
  attributes: { make?: string; model?: string; colors?: string[]; serial?: string;
    components?: string[]; markings?: string[] };
  price: string | null; location: string | null; postedAt: string | null;
  capturedAt: string;
};
export type Evidence = { attribute: string; points: number; possible: number;
  state: 'matched' | 'missing' | 'not_found' | 'conflict'; detail: string };
export type Score = { version: string; total: number; evidence: Evidence[]; conflicts: string[] };
export type Verdict = 'match' | 'not_match' | 'unsure';
export type SearchAdapter = { source: string; search(bike: BikeCase): Promise<{query: string; listings: Listing[]}> };

export function text(value: unknown, max = 5000): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(v => text(v)).filter(Boolean).slice(0, 100) : [];
}
export function httpUrl(value: unknown): string {
  const u = new URL(text(value));
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Expected a public HTTP(S) URL');
  u.hash = '';
  return u.toString();
}
export function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(typeof value === 'number' ? value * 1000 : String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Whitelist object fields: seller identities and arbitrary payloads are never stored.
export function parseListing(raw: any, source: Listing['source'] = 'manual'): Listing {
  if (!raw || typeof raw !== 'object') throw new Error('Listing must be an object');
  const url = httpUrl(raw.url);
  const title = text(raw.title, 500);
  if (!title) throw new Error('Listing title is required');
  const a = raw.attributes ?? {};
  return { source, testData:source==='staged',environment:null,sourceId: text(raw.sourceId, 300) || url, url, title,
    description: text(raw.description), photos: strings(raw.photos).map(httpUrl),
    attributes: { make: text(a.make), model: text(a.model), colors: strings(a.colors),
      serial: text(a.serial), components: strings(a.components), markings: strings(a.markings) },
    price: text(raw.price, 100) || null, location: text(raw.location, 300) || null,
    postedAt: iso(raw.postedAt), capturedAt: new Date().toISOString() };
}
