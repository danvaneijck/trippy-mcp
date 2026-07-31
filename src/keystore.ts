/**
 * Local key custody. The agent wallet's private key is generated on the user's
 * machine at `trippy-mcp init` and never leaves it — the Trippy backend sees
 * only addresses and signatures.
 *
 * Two storage modes at `<home>/keystore.json`:
 *  - "encrypted" (default): scrypt (N=131072, r=8, p=1) + AES-256-GCM,
 *    passphrase from TRIPPY_MCP_PASSPHRASE or an interactive prompt.
 *    Same envelope as injective-agent-sdk keystores.
 *  - "plaintext": raw hex behind file mode 0600 — opt-in (`init --plaintext`)
 *    for zero-config headless setups. Sane because the agent wallet is a
 *    BUDGETED BURNER: worst case is the budget, and sweeps can only go to the
 *    owner address fixed at init.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bech32 } from "bech32";
import { privateKeyToAccount } from "viem/accounts";

import { ToolError } from "./errors.js";

export interface EncryptedKeystore {
  version: 1;
  kind: "encrypted";
  crypto: {
    kdf: "scrypt";
    kdfParams: { n: number; r: number; p: number; dkLen: number; salt: string };
    cipher: "aes-256-gcm";
    nonce: string;
    ciphertext: string;
    authTag: string;
  };
  address: `0x${string}`;
  injAddress: string;
  createdAt: string;
}

export interface PlaintextKeystore {
  version: 1;
  kind: "plaintext";
  privateKey: `0x${string}`;
  address: `0x${string}`;
  injAddress: string;
  createdAt: string;
}

export type Keystore = EncryptedKeystore | PlaintextKeystore;

const SCRYPT_PARAMS = { n: 131072, r: 8, p: 1, dkLen: 32 } as const;

export function evmToInj(address: `0x${string}`): string {
  const bytes = Buffer.from(address.slice(2), "hex");
  return bech32.encode("inj", bech32.toWords(bytes));
}

export function injToEvm(injAddress: string): `0x${string}` {
  const { prefix, words } = bech32.decode(injAddress);
  if (prefix !== "inj") throw new ToolError("bad_address", `not an inj address: ${injAddress}`);
  return `0x${Buffer.from(bech32.fromWords(words)).toString("hex")}` as `0x${string}`;
}

function deriveKey(
  password: string,
  salt: Buffer,
  p: { n: number; r: number; p: number; dkLen: number },
): Buffer {
  return scryptSync(password, salt, p.dkLen, {
    N: p.n,
    r: p.r,
    p: p.p,
    maxmem: 128 * p.n * p.r * p.p + 1024 * 1024,
  });
}

export function buildEncryptedKeystore(
  privateKey: `0x${string}`,
  passphrase: string,
): EncryptedKeystore {
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const derivedKey = deriveKey(passphrase, salt, SCRYPT_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", derivedKey, nonce);
  const plaintext = Buffer.from(privateKey.slice(2), "hex");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  const authTag = cipher.getAuthTag();
  derivedKey.fill(0);

  const address = privateKeyToAccount(privateKey).address;
  return {
    version: 1,
    kind: "encrypted",
    crypto: {
      kdf: "scrypt",
      kdfParams: { ...SCRYPT_PARAMS, salt: salt.toString("hex") },
      cipher: "aes-256-gcm",
      nonce: nonce.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      authTag: authTag.toString("hex"),
    },
    address,
    injAddress: evmToInj(address),
    createdAt: new Date().toISOString(),
  };
}

export function buildPlaintextKeystore(privateKey: `0x${string}`): PlaintextKeystore {
  const address = privateKeyToAccount(privateKey).address;
  return {
    version: 1,
    kind: "plaintext",
    privateKey,
    address,
    injAddress: evmToInj(address),
    createdAt: new Date().toISOString(),
  };
}

export function decryptKeystore(ks: EncryptedKeystore, passphrase: string): `0x${string}` {
  const { kdfParams, nonce, ciphertext, authTag } = ks.crypto;
  const salt = Buffer.from(kdfParams.salt, "hex");
  const derivedKey = deriveKey(passphrase, salt, {
    n: kdfParams.n,
    r: kdfParams.r,
    p: kdfParams.p,
    dkLen: kdfParams.dkLen,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, Buffer.from(nonce, "hex"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "hex")),
      decipher.final(),
    ]);
    const hex = decrypted.toString("hex");
    decrypted.fill(0);
    return `0x${hex}` as `0x${string}`;
  } catch {
    throw new ToolError(
      "keystore_locked",
      "keystore decryption failed — wrong passphrase or corrupted file",
      "set TRIPPY_MCP_PASSPHRASE to the passphrase chosen at `trippy-mcp init`",
    );
  } finally {
    derivedKey.fill(0);
  }
}

export function keystorePath(homeDir: string): string {
  return join(homeDir, "keystore.json");
}

export function loadKeystore(homeDir: string): Keystore {
  const p = keystorePath(homeDir);
  if (!existsSync(p)) {
    throw new ToolError(
      "not_initialized",
      `no keystore at ${p}`,
      "run `trippy-mcp init` to create the agent wallet",
    );
  }
  const ks = JSON.parse(readFileSync(p, "utf-8")) as Keystore;
  if (ks?.version !== 1 || (ks.kind !== "encrypted" && ks.kind !== "plaintext")) {
    throw new ToolError("keystore_invalid", `unsupported keystore at ${p}`);
  }
  return ks;
}

export function saveKeystore(homeDir: string, ks: Keystore): void {
  const p = keystorePath(homeDir);
  mkdirSync(dirname(p), { recursive: true });
  chmodSync(dirname(p), 0o700);
  writeFileSync(p, JSON.stringify(ks, null, 2), { mode: 0o600 });
}

/**
 * Resolve the private key for signing. Encrypted keystores need the
 * passphrase (env TRIPPY_MCP_PASSPHRASE, or passed explicitly from an
 * interactive CLI prompt).
 */
export function unlockKeystore(ks: Keystore, passphrase?: string): `0x${string}` {
  if (ks.kind === "plaintext") return ks.privateKey;
  const pass = passphrase ?? process.env.TRIPPY_MCP_PASSPHRASE;
  if (!pass) {
    throw new ToolError(
      "keystore_locked",
      "keystore is encrypted and no passphrase is available",
      "set TRIPPY_MCP_PASSPHRASE in the MCP server env (see `trippy-mcp init` output)",
    );
  }
  return decryptKeystore(ks, pass);
}
