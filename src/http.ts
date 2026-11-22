/**
 * Shared bounded HTTP requests for official API adapters.
 * Provider error bodies are deliberately excluded from errors to avoid leaking
 * credentials or unrelated personal data into terminal and audit output.
 */
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
    // No response bodies or credentials in error logs.
    throw new Error(
      `HTTP ${r.status} from ${new URL(url).hostname}${r.status === 429 ? '; rate limited, retry later (no automatic retry)' : ''}`,
    );
  }
  const body = await r.text();
  return body.trim() ? JSON.parse(body) : null;
}
