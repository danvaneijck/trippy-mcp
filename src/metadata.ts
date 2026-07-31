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
  if (bytes.length > 5 * 1024 * 1024) {
    throw new ToolError("bad_image", "image larger than 5MB");
  }
  const { url } = await pump.uploadImage(new Uint8Array(bytes), `logo${extname(imagePath)}`, mime);
  return url;
}
