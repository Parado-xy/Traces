import { text, strings, iso, httpUrl } from '../domain.ts';
import type { BikeCase } from '../domain.ts';
import { requestJson } from '../http.ts';

export function normalizeBike(raw: any): BikeCase {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0) throw new Error('Invalid Bike Index id');
  const stolen = raw.stolen === true || raw.status === 'stolen';
  const record = raw.stolen_record ?? {};
  const components = Array.isArray(raw.components) ? raw.components.map((c: any) =>
    [text(c.manufacturer_name),text(c.model_name),text(c.component_type)].filter(Boolean).join(' ')).filter(Boolean) : [];
  return {id:`bikeindex:${raw.id}`, bikeIndexId:raw.id, status:stolen ? 'open' : 'closed', staged:raw.test_bike===true,
    make:text(raw.manufacturer_name,300), model:text(raw.frame_model,300),
    serial:text(raw.serial,300) || null, colors:strings(raw.frame_colors), components,
    // Free prose is preserved as description. No invented extraction of markings.
    markings:[], description:text(raw.description),
    photos:[...new Set([raw.large_img,raw.thumb,...(Array.isArray(raw.public_images) ? raw.public_images.map((x: any)=>x.full ?? x.large) : [])].filter(Boolean).map(httpUrl))],
    stolenLocation:text(raw.stolen_location || record.location,300),
    stolenAt:iso(raw.date_stolen ?? record.date_stolen), reportUrl:`https://bikeindex.org/bikes/${raw.id}`,
    fetchedAt:new Date().toISOString()};
}

export class BikeIndex {
  token: string; fetcher: typeof fetch;
  constructor(token = '', fetcher: typeof fetch = fetch) { this.token=token; this.fetcher=fetcher; }
  async get(id: number): Promise<BikeCase> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Positive Bike Index id required');
    const data = await this.read(`/bikes/${id}`);
    return normalizeBike(data.bike);
  }
  async search(location: string, distance = 100, limit = 5): Promise<BikeCase[]> {
    if (!location.trim() || !Number.isFinite(distance) || distance < 1 || distance > 500 || !Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new Error('Use a region, distance 1..500 miles, and limit 1..25');
    const q = new URLSearchParams({location, distance:String(distance),stolenness:'proximity',per_page:String(limit),page:'1'});
    const data = await this.read(`/search?${q}`);
    if (!Array.isArray(data.bikes)) throw new Error('Malformed Bike Index search response');
    const cases: BikeCase[] = [];
    for (const summary of data.bikes.slice(0,limit)) {
      // Detail call supplies components and photographs, and rechecks current status.
      await new Promise(r => setTimeout(r, 1100));
      const bike = await this.get(summary.id);
      if (bike.status === 'open') cases.push(bike);
    }
    return cases;
  }
  private read(path: string) {
    return requestJson(`https://bikeindex.org/api/v3${path}`,{
      headers:this.token ? {Authorization:`Bearer ${this.token}`} : {}
    },this.fetcher);
  }
}
