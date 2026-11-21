# API exploration notes

Checked November 21, 2026 against official documentation and small read-only live requests. Provider terms and access requirements should be rechecked before production use.

## Bike Index

Official documentation: https://bikeindex.org/documentation/api_v3

Machine-readable endpoint definitions:

- https://bikeindex.org/api/v3/swagger_doc/search
- https://bikeindex.org/api/v3/swagger_doc/bikes

Implemented reads:

| Endpoint | Use |
| --- | --- |
| `GET /api/v3/search` | List stolen cases for a configured region |
| `GET /api/v3/bikes/{id}` | Obtain detail, components, photos, current status |
| `POST /api/v3/bikes/{id}/send_stolen_notification` | Human-gated owner notification through Bike Index |

Proximity search must set `stolenness=proximity`, `location`, and `distance` in miles. `location` is ignored when stolenness is not proximity. `per_page` is at most 100 upstream. Our tool deliberately fetches one page of at most 25 cases (default 3), then requests details sequentially with a 1.1-second pause. These conservative client settings are not a published provider rate limit or a guarantee against throttling.

Read endpoints were accessible without authentication during the live check. Optional OAuth credentials use a Bearer header. Documentation says unauthenticated requests have increased rate limiting; it does not give one stable numeric quota we can safely claim. The client stops on HTTP 429 and exposes a sanitized error. It has a 20-second timeout and does not automatically retry.

Times arrive as UTC Unix seconds and are normalized to ISO 8601. Bike report links are canonical `https://bikeindex.org/bikes/{id}`. Detail responses wrap the record in `bike`; search responses use `bikes`.

### Notification requirements

The endpoint's own Swagger definition says `read_user` scope is required, the application needs approval, and unapproved apps can test by sending to a stolen bike owned by the authenticated user. Approval requests go through Bike Index's documented support route; this project does not send an approval request. The request contains the message form field. This code uses form URL encoding and only the Bike Index notification endpoint.

The adapter's notification path is tested using mocked HTTP responses, including a successful empty 204 response. An authorized owned-bike integration test has not been performed. It must happen before real recovery notifications. Never fabricate a public theft report for testing.

## eBay Browse

Official sources:

- https://developer.ebay.com/develop/api/buy/browse_api
- https://developer.ebay.com/develop/api/buy/browse_api/item/search
- https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html
- https://developer.ebay.com/api-docs/static/oauth-credentials.html

Implemented token exchange: `POST /identity/v1/oauth2/token` with HTTP Basic client credentials, form `grant_type=client_credentials`, and scope `https://api.ebay.com/oauth/api_scope`.

Implemented search: `GET /buy/browse/v1/item_summary/search`, query `q={make} {model} bicycle`, `category_ids=177831` (US bicycle category), `limit=25`, header `X-EBAY-C-MARKETPLACE-ID: EBAY_US`. Sandbox base is `https://api.sandbox.ebay.com`; production is `https://api.ebay.com`.

The adapter stores summary titles, optional short descriptions, item URLs, image URLs, price, listing location, and any supplied creation time. It does not fetch full descriptions or extract serials automatically. Missing aspects remain missing evidence. Returned seller data is not persisted. No pagination, seller endpoints, scheduled polling, scraping, or image search is implemented.

Existence of an official API does not establish that every use is approved. Production access, application-purpose permission, quotas and retention obligations require confirmation with the provider's terms/program. Production is disabled by default pending that confirmation. No numeric production call quota is claimed and no live eBay call was made.

## Other marketplaces

Facebook Marketplace, Craigslist, and OfferUp have no automated adapter here. Their permitted automated routes for this purpose have not been established. The current fallback accepts case-specific object details entered by the operator after manual access permitted by the relevant source. It does not automatically fetch a pasted URL, evade a login, or treat manual import as blanket permission to reuse data.
