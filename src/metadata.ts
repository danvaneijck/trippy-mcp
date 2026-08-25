/**
 * Launch metadata — the on-chain `metadataURI` is an inline
 * `data:application/json;base64,<json>` so the token is self-describing and
 * survives any backend reset (matches frontend/src/lib/metadata.ts).
 *
 * Images are URLs inside that JSON, not embedded bytes: local files are
 * uploaded to the pump API (`POST /uploads/image` → Pinata/IPFS) first.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import type { PumpApi } from "./api/pump.js";
import { ToolError } from "./errors.js";

export interface LaunchMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  twitter?: string;
  website?: string;
  telegram?: string;
}

const MAX_METADATA_BYTES = 8 * 1024; // it's calldata + contract storage — keep it small

/**
 * Contract-side `MAX_TOKEN_NAME_LEN` / `MAX_TOKEN_SYMBOL_LEN`. BYTES, not
 * characters — mirrors `resolve_denom_branding` in LaunchpadCore and
 * `normalizeBrandingField` in the keeper.
 */
export const MAX_TOKEN_NAME_BYTES = 64;
export const MAX_TOKEN_SYMBOL_BYTES = 32;

/**
 * Characters that do not render as themselves: C0/C1 controls, zero-width
 * formatting, and the bidi overrides and isolates that let `MOORHS` display as
 * `SHROOM`. Mirrors `is_renderable_branding_char` in the contract.
 */
// eslint-disable-next-line no-control-regex
const NON_RENDERING =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * Refuse branding the chain would silently discard.
 *
 * `MsgCreateDenom` is the ONLY write: the issuer renounces the denom admin a
 * few blocks later, after which `MsgSetDenomMetadata` is refused on both the
 * admin and the governance path. So a name the contract will not accept is not
 * a validation warning — the token is called `shroom_114_a1b2c3…` on every
 * explorer and on its auto-deployed ERC20 pair, forever, and the creator has
 * already paid the fee. The contract DROPS rather than truncates, deliberately,
 * so the only safe place to catch it is before the launch is broadcast.
 *
 * Measured in bytes because that is how the chain measures it: 40 CJK
 * characters are 40 JS string units and 120 bytes.
 */
export function assertBrandable(field: "name" | "symbol", value: string): void {
  const max = field === "name" ? MAX_TOKEN_NAME_BYTES : MAX_TOKEN_SYMBOL_BYTES;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > max) {
    throw new ToolError(
      "bad_branding",
      `${field} is ${bytes} UTF-8 bytes, over the chain's ${max}-byte limit — it would be dropped and the token would keep its raw denom as its ${field} forever`,
      value.length !== bytes
        ? `it is ${value.length} characters but ${bytes} bytes: accents, CJK and emoji each count for several`
        : `shorten it to ${max} characters`,
    );
  }
  if (NON_RENDERING.test(value)) {
    throw new ToolError(
      "bad_branding",
      `${field} contains a non-rendering character (a control, zero-width or bidi-override codepoint), which the launchpad rejects`,
      "these are what let one name display as another, so they are refused outright — use plain text",
    );
  }
  if (value.trim() === "") {
    throw new ToolError("bad_branding", `${field} cannot be blank`);
  }
}

export function encodeMetadataUri(meta: LaunchMetadata): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string" && v.trim() !== "") clean[k] = v.trim();
  }
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json) > MAX_METADATA_BYTES) {
    throw new ToolError("metadata_too_large", "launch metadata exceeds 8KB — shorten the description");
  }
  return `data:application/json;base64,${Buffer.from(json, "utf-8").toString("base64")}`;
}

export function decodeMetadataUri(uri: string): LaunchMetadata | null {
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf-8")) as LaunchMetadata;
    }
    if (uri.startsWith("data:application/json,")) {
      return JSON.parse(decodeURIComponent(uri.slice(22))) as LaunchMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Resolve the `image` field: an https URL passes through; a local file path
 * is uploaded to IPFS via the pump API and becomes its gateway URL.
 */
export async function resolveImage(
  pump: PumpApi,
  imageUrl?: string,
  imagePath?: string,
): Promise<string | undefined> {
  if (imageUrl) {
    if (!/^https?:\/\//.test(imageUrl)) {
      throw new ToolError("bad_image", "imageUrl must be an http(s) URL — use imagePath for local files");
    }
    return imageUrl;
  }
  if (!imagePath) return undefined;
  const mime = MIME_BY_EXT[extname(imagePath).toLowerCase()];
  if (!mime) {
    throw new ToolError("bad_image", "imagePath must be a .png/.jpg/.jpeg/.webp/.gif file");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(imagePath);
  } catch {
    throw new ToolError("bad_image", `cannot read image file at ${imagePath}`);
  }
  // Mirrors the backend's `UPLOAD_MAX_BYTES` (2 MB). It used to say 5 MB, which
  // meant a 2-5 MB logo was read, POSTed, and rejected by the server — a
  // round trip and a worse error for something knowable locally. The backend
  // downscales into a 512px box and re-encodes to (animated) webp itself, so
  // this is purely a transfer cap, not a quality one.
  if (bytes.length > 2 * 1024 * 1024) {
    throw new ToolError(
      "bad_image",
      `image is ${(bytes.length / 1024 / 1024).toFixed(2)} MB — the launchpad accepts up to 2 MB`,
      "the server downscales to 512px and re-encodes to webp anyway, so shrink it to fit and nothing is lost",
    );
  }
  const { url } = await pump.uploadImage(new Uint8Array(bytes), `logo${extname(imagePath)}`, mime);
  return url;
}

/**
 * Resolve an avatar reference for the agent registry: an http(s) URL passes
 * through, anything else is treated as a local image file and uploaded to
 * IPFS via the pump API.
 */
export function resolveAvatar(pump: PumpApi, ref: string): Promise<string | undefined> {
  return /^https?:\/\//.test(ref) ? resolveImage(pump, ref) : resolveImage(pump, undefined, ref);
}
