import { describe, expect, it } from "vitest";

import {
  assertBrandable,
  MAX_TOKEN_NAME_BYTES,
  MAX_TOKEN_SYMBOL_BYTES,
} from "../src/metadata.js";

/**
 * Branding is written ONCE, at `MsgCreateDenom`, and the issuer renounces the
 * denom admin a few blocks later — after which `MsgSetDenomMetadata` is refused
 * on both the admin and the governance path. The contract DROPS branding it
 * will not accept rather than truncating it, deliberately, because a mangled
 * name is worse than the raw denom.
 *
 * So everything below is the difference between a launch with the name its
 * creator chose and one called `shroom_114_a1b2c3d4e5f6a7b8` on every explorer,
 * forever, on a token whose creator already paid the fee. Limits mirror the
 * keeper's `normalizeBrandingField` and the contract's `resolve_denom_branding`.
 *
 * Control codepoints are written as escapes on purpose — a literal one in a
 * test file is invisible to every reviewer of the diff, which is the same
 * property that makes them worth rejecting in the first place.
 */
describe("launch branding", () => {
  it("measures the limit in BYTES, not characters", () => {
    // The trap: 40 CJK characters are 40 JS string units and 120 UTF-8 bytes,
    // so a character-counting cap waves them straight through.
    const cjk = "柴".repeat(40);
    expect(cjk.length).toBe(40);
    expect(Buffer.byteLength(cjk, "utf8")).toBe(120);
    expect(() => assertBrandable("name", cjk)).toThrow(/UTF-8 bytes/);
  });

  it("says how many characters vs bytes, since that is the whole confusion", () => {
    try {
      assertBrandable("name", "\u{1F344}".repeat(20));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/characters but \d+ bytes/);
    }
  });

  it("accepts a name that is exactly at the byte limit", () => {
    expect(() => assertBrandable("name", "A".repeat(MAX_TOKEN_NAME_BYTES))).not.toThrow();
    expect(() => assertBrandable("name", "A".repeat(MAX_TOKEN_NAME_BYTES + 1))).toThrow();
  });

  it("accepts multi-byte branding that fits", () => {
    // 20 CJK characters is 60 bytes — under the cap, and a perfectly good name.
    expect(() => assertBrandable("name", "柴".repeat(20))).not.toThrow();
  });

  it("holds the symbol to its own, smaller cap", () => {
    expect(MAX_TOKEN_SYMBOL_BYTES).toBe(32);
    expect(() => assertBrandable("symbol", "A".repeat(32))).not.toThrow();
    expect(() => assertBrandable("symbol", "A".repeat(33))).toThrow(/32-byte/);
  });

  it("refuses bidi overrides, which are what make one name display as another", () => {
    // U+202E flips the run that follows it, so this renders as SHROOM.
    expect(() => assertBrandable("symbol", "MOORHS\u202E")).toThrow(/non-rendering/);
  });

  it("refuses zero-width and control characters", () => {
    const sneaky = [
      "SHR\u200BOOM", // zero-width space
      "SHROOM\u0007", // C0 control
      "SHROOM\u200F", // right-to-left mark
      "\uFEFFSHROOM", // byte-order mark
      "SHR\u2066OOM", // bidi isolate
    ];
    for (const s of sneaky) {
      expect(() => assertBrandable("symbol", s)).toThrow(/non-rendering/);
    }
  });

  it("refuses blank branding", () => {
    expect(() => assertBrandable("name", "   ")).toThrow(/cannot be blank/);
  });

  it("passes ordinary ASCII branding through", () => {
    expect(() => assertBrandable("name", "Injective Egg")).not.toThrow();
    expect(() => assertBrandable("symbol", "INJEGG")).not.toThrow();
  });
});
