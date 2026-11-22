/**
 * Shared bounded HTTP requests for official API adapters.
 * Provider error bodies are deliberately excluded from errors to avoid leaking
 * credentials or unrelated personal data into terminal and audit output.
 */

/**
 * A provider failure carrying only an HTTP status and a constrained error code.
 * Raw error bodies, token values, and provider error descriptions are excluded.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  /** Creates an operator-facing diagnostic without serializing provider payloads. */
  constructor(status: number, hostname: string, code: string | null) {
    super(
      `HTTP ${status} from ${hostname}${code ? ` [${code}]` : ''}${status === 429 ? '; rate limited, retry later (no automatic retry)' : ''}`,
    );
    this.status = status;
    this.code = code;
  }
}

/** Extracts only documented machine-readable codes, never arbitrary error messages. */
function providerErrorCode(body: string): string | null {
  try {
    const payload = JSON.parse(body);
    const code = payload?.error ?? payload?.errors?.[0]?.errorId;
    if (typeof code === 'number' && Number.isSafeInteger(code)) {
      return String(code);
    }
    // Whitelisting known OAuth identifiers avoids treating a provider's free-form
    // error string as a safe diagnostic (it could contain sensitive input).
    const oauthCodes = new Set([
      'invalid_client',
      'invalid_grant',
      'invalid_request',
      'invalid_scope',
      'unauthorized_client',
      'unsupported_grant_type',
      'access_denied',
    ]);
    return typeof code === 'string' && oauthCodes.has(code) ? code : null;
  } catch {
    return null;
  }
}
/**
 * Requests JSON with a timeout, redirect rejection, and sanitized HTTP errors.
 * @param url The provider endpoint selected by its adapter.
 * @param init Request method, headers, and body.
 * @param fetcher Real fetch or an injected test transport.
 * @returns Parsed JSON, or null for a successful empty response such as HTTP 204.
 * @throws For non-success HTTP status, invalid JSON, timeout, or transport failure.
 * No automatic retry is performed, including after HTTP 429.
 */
export async function requestJson(
  url: string | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<any> {
  const r = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    // Retain only safe error identifiers useful for diagnosing mismatched keys,
    // scopes and provider access. Do not echo descriptions or response bodies.
    const body = await r.text();
    throw new ProviderHttpError(r.status, new URL(url).hostname, providerErrorCode(body));
  }
  const body = await r.text();
  if (!body.trim()) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    // Native JSON parse errors can quote the raw input; sanitize that path too.
    throw new Error(`Invalid JSON response from ${new URL(url).hostname}`);
  }
}
