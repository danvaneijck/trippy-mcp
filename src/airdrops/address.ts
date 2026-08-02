/**
 * Recipient address validation and the never-allocate lists.
 *
 * Validation is full bech32 (checksum included), not a charset regex, for the
 * reason spelled out in units.ts: a claim-drop leaf never meets a chain rule
 * that would reject a typo, so a well-formed-but-wrong address is funded,
 * frozen and unclaimable forever. `bech32` is already a direct dependency here
 * (the keystore derives the inj address with it), so this costs nothing.
 */

import { bech32 } from "bech32";

export function isValidInjAddress(address: string): boolean {
  const addr = (address || "").trim();
  if (!addr.startsWith("inj1")) return false;
  try {
    const { prefix, words } = bech32.decode(addr);
    if (prefix !== "inj") return false;
    // 20-byte accounts and 32-byte contracts are both legitimate recipients.
    const bytes = bech32.fromWords(words).length;
    return bytes === 20 || bytes === 32;
  } catch {
    return false;
  }
}

/**
 * Bank-module blocked addresses on Injective mainnet — the x/auth module
 * accounts. The bank keeper refuses to credit any of them, so an allocation to
 * one is value that enters the drop and can never leave it.
 *
 * Derived deterministically from the module name (authtypes.NewModuleAddress),
 * so they never change. Source: GET /cosmos/auth/v1beta1/module_accounts
 * (mainnet), 2026-07-09.
 */
export const BLOCKED_RECIPIENTS: ReadonlySet<string> = new Set([
  "inj1j4yzhgjm00ch3h0p9kel7g8sp6g045qf32pzlj", // auction
  "inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3lj7tt0", // bonded_tokens_pool
  "inj1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8dkncm8", // distribution
  "inj1glht96kr2rseywuvhhay894qw7ekuc4qqdy7m7", // erc20
  "inj1vqu8rska6swzdmnhf90zuv0xmelej4lq8mjsxs", // evm
  "inj14vnmw2wee3xtrsqfvpcqg35jg9v7j2vdpzx0kk", // exchange
  "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9", // fee_collector
  "inj176rcyfn5k9d0wcxel3kmwvxh0hy3xcwen9585u", // feeibc
  "inj10d07y265gmmuvt4z0w9aw880jnsr700jstypyt", // gov
  "inj1vn5fx74ud4cu7tf0pls9u5krxengsdzrg9ap2d", // insurance
  "inj1vlthgax23ca9syk7xgaz347xmf4nunefdppn7g", // interchainaccounts
  "inj1m3h30wlvsf8llruxtpukdvsy0km2kum8zcsu4c", // mint
  "inj1tygms3xhhs3yv487phx3dw4a95jn7t7ltjz6am", // not_bonded_tokens_pool
  "inj1979qcq0kdz72w0k9rsxcmfmagx2cydrs40q2xg", // peggy
  "inj1fl3um4qyagpfpwked5lpenvjj7wn8trr93jdku", // permissions
  "inj19ejy8n9qsectrf4semdp9cpknflld0j6hf2fle", // tokenfactory
  "inj1yl6hdjhmkf37639730gffanpzndzdpmhykpd9m", // transfer
  "inj1h3j5kq3efj96ga8gre6pxmp2qmfvs994clv2su", // txfees
  "inj1xds4f0m87ajl3a6az6s2enhxrd0wta4860twp8", // wasm
  "inj1z5ewmnfpa3at4j54pq6dh66rthrpkvhnxqadkf", // xwasm
]);

/**
 * Contracts that hold real balances on everyone's behalf and no keys of their
 * own. They are holders by every snapshot's reckoning and recipients by none.
 */
export const NON_WALLET_HOLDERS: ReadonlySet<string> = new Set([
  "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk", // CW20 adapter
  "inj1wu0cs0zl38pfss54df6t7hq82k3lgmcdex2uwn", // Dojo burn
  "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49", // burn
  "inj14vnmw2wee3xtrsqfvpcqg35jg9v7j2vdpzx0kk", // Mito / exchange module
  "inj1gtze7qm07nky47n7mwgj4zatf2s77xqvh3k2n8", // Mito staking
  "inj1vcqkkvqs7prqu70dpddfj7kqeqfdz5gg662qs3", // Mito vault
]);

/**
 * Build the exclusion predicate for one drop.
 *
 * `extra` is where launch-aware exclusions go. They matter more here than in
 * the site's version of this tool, because the agent-native case is "reward the
 * holders of the token I launched" — and on a curve launch the largest holder
 * by far is the launch's own sink, which holds all the unsold supply. Missing
 * it would airdrop most of the total back to the protocol.
 */
export function exclusionSet(extra: Iterable<string> = []): (address: string) => boolean {
  const set = new Set<string>([...BLOCKED_RECIPIENTS, ...NON_WALLET_HOLDERS]);
  for (const a of extra) {
    const t = (a || "").trim();
    if (t) set.add(t);
  }
  return (address: string) => set.has((address || "").trim());
}
