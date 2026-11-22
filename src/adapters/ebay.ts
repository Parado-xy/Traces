/**
 * Searches eBay for object listings related to one open bicycle case.
 *
 * This adapter owns authentication and provider-response normalization. Scoring,
 * persistence, and human review belong to the layers that call it. It never
 * persists seller data or obtains an access token before checking the case and
 * application permissions.
 */
import type { BikeCase, Listing, SearchAdapter } from '../domain.ts';
import { parseListing } from '../domain.ts';
import { caseQuery } from '../score.ts';
import { requestJson } from '../http.ts';

/** Credentials and access settings for exactly one eBay environment. */
export type EbayConfig = {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
  productionApproved: boolean;
};

/**
 * Runs a bounded, case-specific search through the official Browse API.
 * Sandbox inventory is explicitly marked as test data so it cannot notify real
 * owners or contribute to real-case candidate metrics.
 */
export class Ebay implements SearchAdapter {
  source = 'ebay';
  config: EbayConfig;
  fetcher: typeof fetch;

  /**
   * Keeps provider configuration and an injectable HTTP transport in memory.
   * @param config Credentials and the operator's production-access confirmation.
   * @param fetcher Real fetch by default; tests inject an isolated HTTP stub.
   */
  constructor(config: EbayConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  /**
   * Returns up to 25 normalized bicycle listings for one open case.
   * Staged cases are allowed only in sandbox for controlled integration tests.
   * @param bike The case supplying the make/model search terms.
   * @returns The exact query and object-only candidates for scoring and review.
   * @throws If access is not configured, the case is ineligible, or eBay fails.
   * Performs token and search requests, but does not store data or contact sellers.
   */
  async search(bike: BikeCase): Promise<{ query: string; listings: Listing[] }> {
    // Check eligibility before any network call. A case being present in the
    // database does not by itself authorize searching production inventory.
    this.assertSearchAllowed(bike);

    const host =
      this.config.environment === 'production'
        ? 'https://api.ebay.com'
        : 'https://api.sandbox.ebay.com';
    const accessToken = await this.getAccessToken(host);

    // Use one page in the US bicycle category. The MVP deliberately does not
    // paginate into a standing marketplace index or query seller endpoints.
    const query = caseQuery(bike);
    const searchParameters = new URLSearchParams({
      q: query,
      limit: '25',
      category_ids: '177831',
    });
    const response = await requestJson(
      `${host}/buy/browse/v1/item_summary/search?${searchParameters}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      },
      this.fetcher,
    );

    if (!response || (!Array.isArray(response.itemSummaries) && response.total !== 0)) {
      throw new Error('Malformed eBay search response');
    }

    // Normalize only the attributes needed to evaluate the object. The raw
    // response may contain seller fields; none cross this adapter boundary.
    const listings = (response.itemSummaries ?? [])
      .slice(0, 25)
      .map((item: any) => this.normalizeSummary(item));

    return { query, listings };
  }

  /** Rejects cases or configurations that must not initiate an eBay request. */
  private assertSearchAllowed(bike: BikeCase): void {
    if (bike.status !== 'open') {
      throw new Error('Search requires an open case');
    }

    if (bike.staged && this.config.environment === 'production') {
      throw new Error('Staged cases cannot search production eBay inventory');
    }

    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error('Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET');
    }

    if (this.config.environment === 'production' && !this.config.productionApproved) {
      throw new Error(
        'Production disabled: confirm eBay access and intended-use permission, then set EBAY_PRODUCTION_APPROVED=true',
      );
    }
  }

  /**
   * Exchanges application credentials for a Browse API access token.
   * @param host The API origin selected from the configured environment.
   * @returns A token used only in memory for the following search request.
   * @throws If the provider request fails or the response omits its access token.
   */
  private async getAccessToken(host: string): Promise<string> {
    const encodedCredentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    // eBay requires Basic authentication for the client-credentials exchange;
    // subsequent Browse requests use the returned Bearer token instead.
    const tokenResponse = await requestJson(
      `${host}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${encodedCredentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'https://api.ebay.com/oauth/api_scope',
        }),
      },
      this.fetcher,
    );

    if (!tokenResponse || typeof tokenResponse.access_token !== 'string') {
      throw new Error('eBay token response missing access token');
    }

    return tokenResponse.access_token;
  }

  /**
   * Copies an API summary into the shared object-only listing schema.
   * Unknown object attributes remain missing rather than being guessed from the
   * title. Marking sandbox data here prevents later code from treating it as real.
   */
  private normalizeSummary(item: any): Listing {
    const listing = parseListing(
      {
        sourceId: item.itemId,
        url: item.itemWebUrl,
        title: item.title,
        description: item.shortDescription,
        photos: [
          item.image?.imageUrl,
          ...(item.additionalImages ?? []).map((image: any) => image.imageUrl),
        ].filter(Boolean),
        price: item.price ? `${item.price.value} ${item.price.currency}` : null,
        location: [
          item.itemLocation?.city,
          item.itemLocation?.stateOrProvince,
          item.itemLocation?.country,
        ]
          .filter(Boolean)
          .join(', '),
        postedAt: item.itemCreationDate,
        attributes: {},
      },
      'ebay',
    );

    return {
      ...listing,
      testData: this.config.environment === 'sandbox',
      environment: this.config.environment,
    };
  }
}
