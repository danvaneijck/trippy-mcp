/**
 * `fetch` for OUR apis: the SHROOM Pad / Sprout api, api.choice.exchange and
 * evm-api.choice.exchange.
 *
 * Since 2026-10-14 those apis serve our own websites on their Origin and every
 * other caller on an `X-API-Key`. This package is neither: it runs on its users'
 * own machines, so it cannot keep a secret, and it is not a browser. It names
 * itself instead (`X-Client: trippy-mcp/<version>`), and the apis serve that name
 * like one of our sites, under the same per-IP limits. An install older than
 * this sends no name and is refused once the apis enforce: the refusal says to
 * update.
 */

import { PKG_VERSION } from "../version.js";

export const CLIENT_ID = `trippy-mcp/${PKG_VERSION}`;

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Client", CLIENT_ID);
  if (!headers.has("User-Agent")) headers.set("User-Agent", CLIENT_ID);
  return fetch(url, { ...init, headers });
}
