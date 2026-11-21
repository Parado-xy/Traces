export async function requestJson(url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<any> {
  const r = await fetcher(url, {...init, redirect:'error', signal:AbortSignal.timeout(20000)});
  if (!r.ok) {
    // No response bodies or credentials in error logs.
    throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}${r.status === 429 ? '; rate limited, retry later (no automatic retry)' : ''}`);
  }
  const body=await r.text();
  return body.trim() ? JSON.parse(body) : null;
}
