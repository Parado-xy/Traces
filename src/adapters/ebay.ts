import type { BikeCase, Listing, SearchAdapter } from '../domain.ts';
import { parseListing } from '../domain.ts';
import { caseQuery } from '../score.ts';
import { requestJson } from '../http.ts';

export class Ebay implements SearchAdapter {
  source = 'ebay';
  config: {clientId:string; clientSecret:string; environment:'sandbox'|'production'; productionApproved:boolean};
  fetcher: typeof fetch;
  constructor(config: Ebay['config'], fetcher: typeof fetch = fetch) {this.config=config;this.fetcher=fetcher;}
  async search(bike: BikeCase): Promise<{query:string; listings:Listing[]}> {
    if (bike.status !== 'open') throw new Error('Search requires an open case');
    if (bike.staged) throw new Error('Staged cases use staged fixtures, not live eBay');
    if (!this.config.clientId || !this.config.clientSecret) throw new Error('Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET');
    if (this.config.environment === 'production' && !this.config.productionApproved)
      throw new Error('Production disabled: confirm eBay access and intended-use permission, then set EBAY_PRODUCTION_APPROVED=true');
    const host = this.config.environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
    const token = await requestJson(`${host}/identity/v1/oauth2/token`,{
      method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})
    },this.fetcher);
    if (typeof token.access_token !== 'string') throw new Error('eBay token response missing access token');
    const query = caseQuery(bike);
    const q = new URLSearchParams({q:query,limit:'25',category_ids:'177831'});
    const data = await requestJson(`${host}/buy/browse/v1/item_summary/search?${q}`,{
      headers:{Authorization:`Bearer ${token.access_token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'}
    },this.fetcher);
    if (!Array.isArray(data.itemSummaries) && data.total !== 0) throw new Error('Malformed eBay search response');
    const listings = (data.itemSummaries ?? []).slice(0,25).map((item: any) => ({...parseListing({
      sourceId:item.itemId,url:item.itemWebUrl,title:item.title,description:item.shortDescription,
      photos:[item.image?.imageUrl,...(item.additionalImages ?? []).map((i: any)=>i.imageUrl)].filter(Boolean),
      price:item.price ? `${item.price.value} ${item.price.currency}` : null,
      location:[item.itemLocation?.city,item.itemLocation?.stateOrProvince,item.itemLocation?.country].filter(Boolean).join(', '),
      postedAt:item.itemCreationDate,attributes:{}
    },'ebay'),testData:this.config.environment==='sandbox',environment:this.config.environment}));
    // Raw API payload (including any seller fields) is discarded here.
    return {query,listings};
  }
}
