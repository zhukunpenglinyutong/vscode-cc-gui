// Minimal SSRF-hardened JSON fetcher for the MCP marketplace's 3 hardcoded remote sources.
// Kept as the default `fetchJson` implementation; `McpMarketplaceService` accepts an
// override so the client/entry logic can be unit tested without any real network access.

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/** Hard cap on a single response body to avoid memory exhaustion from a hostile source. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Overall request timeout (connect + response) — Node's http module only exposes one knob. */
const REQUEST_TIMEOUT_MS = 15_000;

export type McpMarketplaceFetchJson = (url: string) => Promise<unknown>;

/** GETs `url` and parses the body as JSON. Never follows redirects; any 3xx is a failure. */
export function fetchMcpMarketplaceJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid MCP marketplace URL: ${url}`));
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'vscode-cc-gui-mcp-marketplace',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      // Redirects are never followed: a 3xx Location could point at an internal address.
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status} from ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let sizeExceeded = false;

      response.on('data', (chunk: Buffer) => {
        if (sizeExceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          sizeExceeded = true;
          reject(new Error(`Response from ${url} exceeded the ${MAX_RESPONSE_BYTES}-byte limit`));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (sizeExceeded) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`));
        }
      });

      response.on('error', (error) => reject(error));
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on('error', (error) => reject(error));
  });
}
