import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildEncryptedKeystore,
  buildPlaintextKeystore,
  decryptKeystore,
  evmToInj,
  injToEvm,
  keystorePath,
  loadKeystore,
  saveKeystore,
  unlockKeystore,
} from "../src/keystore.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

describe("keystore", () => {
  it("encrypt/decrypt roundtrip", () => {
    const ks = buildEncryptedKeystore(KEY, "correct horse battery");
    expect(decryptKeystore(ks, "correct horse battery")).toBe(KEY);
  });

  it("wrong passphrase fails loudly", () => {
    const ks = buildEncryptedKeystore(KEY, "right");
    expect(() => decryptKeystore(ks, "wrong")).toThrow(/decryption failed/);
  });

  it("save/load with 0600 file mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "trippy-ks-"));
    saveKeystore(dir, buildPlaintextKeystore(KEY));
    const mode = statSync(keystorePath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = loadKeystore(dir);
    expect(unlockKeystore(loaded)).toBe(KEY);
  });

  it("address forms agree (same 20 bytes)", () => {
    const ks = buildPlaintextKeystore(KEY);
    expect(ks.injAddress.startsWith("inj1")).toBe(true);
    expect(injToEvm(ks.injAddress).toLowerCase()).toBe(ks.address.toLowerCase());
    expect(evmToInj(ks.address)).toBe(ks.injAddress);
  });
});
