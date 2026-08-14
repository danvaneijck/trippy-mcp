/**
 * `trippy-mcp identity …` — the agent's ERC-8004 on-chain identity.
 *
 * Two registries, on purpose. `agent_identities` (SHROOM Pad backend) is the
 * badge layer joined to our indexed trades; ERC-8004 is the ecosystem's
 * portable, cross-chain passport with a reputation registry behind it. The
 * second is a superset in reach and a subset in detail, so both are kept — and
 * they join for free, because `getAgentWallet(agentId)` is the same lowercase
 * 0x that `trades.trader` keys on.
 *
 * Command shape and the reason for it:
 *
 *   register   mint the identity. ONE transaction: the registry links
 *              `agentWallet = msg.sender` itself, so the agent ends up owning
 *              AND being the wallet of its own identity — which is what all 930
 *              live mainnet agents look like.
 *   show       what the chain says, including which of us holds custody.
 *   link       mint the EIP-712 signature the OPERATOR needs to point
 *              `agentWallet` back at this agent.
 *   transfer   hand the NFT to `ownerSweepAddress`, so a compromised burner
 *              cannot steal the identity.
 *
 * ⚠ The order is transfer-then-link, and it CANNOT be link-then-transfer as
 * originally designed. Two measured contract behaviours force it:
 *   - `safeTransferFrom` clears `agentWallet` to `0x0`, so a link minted before
 *     the transfer is wiped by it;
 *   - a wallet-link signature is valid for at most 300 seconds, so it cannot be
 *     minted now and used by a human later.
 * `link` is therefore cheap, re-runnable, and meant to be run WHILE the
 * operator has the Terminal open.
 */

import type { Address } from "viem";

import { assertValidCard, cardUrl } from "../identity/card.js";
import { IdentityRegistry, type IdentityView } from "../identity/registry.js";
import { loadIdentityState, saveIdentityState } from "../identity/state.js";
import type { Runtime } from "../runtime.js";

const USAGE = `usage: trippy-mcp identity <register|show|link|transfer> [options]

  register              mint the on-chain identity (one tx, ~0.0006 USD of gas)
                        [--force] mint a second identity even if one is recorded
  show [--agent-id N]   read the identity from the chain
  link                  mint the wallet-link signature the operator submits
                        (valid for at most 300s — run it with the Terminal open)
  transfer --yes        hand the identity NFT to the owner address fixed at init
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The agentId this install knows about: local record first, then the backend. */
async function resolveAgentId(rt: Runtime, argv: string[]): Promise<bigint | null> {
  const explicit = flag(argv, "--agent-id");
  if (explicit) return BigInt(explicit);
  const local = loadIdentityState(rt.home);
  if (local) return BigInt(local.agentId);
  try {
    const { agent } = await rt.pump.getAgent(rt.signer.address.toLowerCase());
    if (agent?.erc8004AgentId) return BigInt(agent.erc8004AgentId);
  } catch {
    // backend unreachable — the local record is the only source, and it is absent
  }
  return null;
}

function renderView(v: IdentityView, out: (s: string) => void): void {
  out(`  agentId       ${v.agentId}`);
  out(`  owner         ${v.owner}`);
  out(`  agentWallet   ${v.agentWallet}`);
  out(`  custody       ${v.custody}${custodyNote(v.custody)}`);
  out(`  builderCode   ${v.builderCode || "(unset)"}`);
  out(`  agentType     ${v.agentType || "(unset)"}`);
  out(`  card          ${v.cardUri}`);
  // Only mainnet has an explorer page; a blank label is worse than none.
  if (v.scanUrl) out(`  8004scan      ${v.scanUrl}`);
}

function custodyNote(custody: IdentityView["custody"]): string {
  switch (custody) {
    case "agent":
      return "  (the agent owns its own identity — run `identity transfer` to hand it to the operator)";
    case "owner":
      return "  (owned by the operator, wallet points at the agent — the target state)";
    case "unlinked":
      return "  🔴 (agentWallet is zero: trades are NOT attributable — run `identity link`)";
    case "foreign":
      return "  (neither the owner nor the wallet is this agent)";
  }
}

export async function identityCommand(rt: Runtime, argv: string[]): Promise<void> {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const action = argv[0] ?? "show";
  const registry = new IdentityRegistry(rt.net, rt.signer);

  if (!registry.available) {
    out(`no ERC-8004 registry is configured for ${rt.net.name}`);
    process.exitCode = 1;
    return;
  }

  switch (action) {
    case "register":
      return registerAction(rt, registry, argv, out);
    case "show":
      return showAction(rt, registry, argv, out);
    case "link":
      return linkAction(rt, registry, argv, out);
    case "transfer":
      return transferAction(rt, registry, argv, out);
    default:
      out(USAGE);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------

async function registerAction(
  rt: Runtime,
  registry: IdentityRegistry,
  argv: string[],
  out: (s: string) => void,
): Promise<void> {
  const existing = loadIdentityState(rt.home);
  if (existing && !argv.includes("--force")) {
    out(`already registered as agentId ${existing.agentId} (${registry.scanUrl(existing.agentId)})`);
    out("re-run with --force to mint a SECOND identity (rarely what you want)");
    process.exitCode = 1;
    return;
  }

  const agentAddress = rt.signer.address.toLowerCase();
  const uri = cardUrl(rt.net.pumpApiBase, agentAddress);

  // Refuse to mint a pointer at a card that does not exist or does not parse.
  // `tokenURI` is written once and is expensive-to-impossible to change later
  // (after custody moves, only the operator can call setAgentURI), so a 404
  // here would be permanent.
  const raw = await rt.pump.agentCard(agentAddress);
  const card = assertValidCard(raw, uri);
  out(`card OK: "${card.name}" → ${uri}`);

  const { agentId, tx } = await registry.register(uri);
  out(`register tx ${tx.hash ?? "(dry-run)"} — ${tx.status}`);
  if (tx.status === "reverted") {
    process.exitCode = 1;
    return;
  }
  if (tx.status === "dry-run") {
    out("dry-run: nothing was broadcast (policy.dryRun is on)");
    return;
  }
  if (!agentId) {
    out("🔴 the transaction was broadcast but the agentId could not be read back.");
    out("   Do NOT re-run register — it would mint a second identity.");
    out("   Find the id on the tx in the explorer, then record it with:");
    out("     trippy-mcp identity show --agent-id <id>");
    process.exitCode = 1;
    return;
  }

  saveIdentityState(rt.home, {
    agentId,
    chainId: rt.net.evmChainId,
    registry: registry.address,
    cardUri: uri,
    txHash: tx.hash,
    registeredAt: new Date().toISOString(),
  });
  rt.audit.append("agent:erc8004-registered", {
    agentAddress,
    agentId,
    chainId: rt.net.evmChainId,
    hash: tx.hash,
  });

  // Tell the backend, so the card can carry its own agentId and the Terminal
  // can show the identity. Best-effort: the chain is the source of truth and a
  // failure here must not look like a failed registration.
  try {
    await recordBackend(rt, { agentId });
    out("recorded with the SHROOM Pad backend");
  } catch (e) {
    out(`(could not record with the backend: ${e instanceof Error ? e.message : String(e)})`);
  }

  const view = await registry.view(BigInt(agentId));
  out("");
  renderView(view, out);
  out("");
  out("Next: `trippy-mcp identity transfer --yes` hands the identity to the owner wallet,");
  out("then `trippy-mcp identity link` mints the signature that re-points it back here.");
}

async function showAction(
  rt: Runtime,
  registry: IdentityRegistry,
  argv: string[],
  out: (s: string) => void,
): Promise<void> {
  const agentId = await resolveAgentId(rt, argv);
  if (agentId === null) {
    out("no ERC-8004 identity recorded for this agent.");
    out("run `trippy-mcp identity register` to mint one (~$0.0006 of gas).");
    return;
  }
  const view = await registry.view(agentId);
  renderView(view, out);

  // An explicit --agent-id that checks out is also how a lost identity.json is
  // rebuilt — otherwise the id would have to be re-supplied on every call.
  if (!loadIdentityState(rt.home) && view.custody !== "foreign") {
    saveIdentityState(rt.home, {
      agentId: view.agentId,
      chainId: view.chainId,
      registry: view.registry,
      cardUri: view.cardUri,
      registeredAt: new Date().toISOString(),
    });
    out("");
    out("(recorded locally — identity.json was missing)");
  }
}

async function linkAction(
  rt: Runtime,
  registry: IdentityRegistry,
  argv: string[],
  out: (s: string) => void,
): Promise<void> {
  const agentId = await resolveAgentId(rt, argv);
  if (agentId === null) {
    out("no ERC-8004 identity recorded — run `trippy-mcp identity register` first.");
    process.exitCode = 1;
    return;
  }

  const owner = (await registry.ownerOf(agentId)) as Address;
  const configured = rt.cfg.ownerSweepAddress as Address;
  const me = rt.signer.address.toLowerCase();

  // The signature binds the address that will SUBMIT it. Signing for anyone but
  // the current owner mints a blob that reverts with "invalid wallet sig".
  if (owner.toLowerCase() !== configured.toLowerCase() && owner.toLowerCase() !== me) {
    out(`🔴 agent ${agentId} is owned by ${owner}, which is neither this agent nor`);
    out(`   the configured owner ${configured}. Refusing to sign a link for it.`);
    process.exitCode = 1;
    return;
  }

  // Still self-owned: the agent can submit the link itself, no human needed.
  if (owner.toLowerCase() === me) {
    const wallet = await registry.getAgentWallet(agentId);
    if (wallet.toLowerCase() === me) {
      out(`agentWallet is already ${wallet} — nothing to link.`);
      out("(`identity link` is for after `identity transfer`, when only the owner can submit.)");
      return;
    }
    out("this agent still owns the identity, so it can submit the link itself…");
    const selfLink = await registry.signWalletLink({ agentId, owner: rt.signer.address });
    const tx = await registry.setAgentWallet(selfLink);
    out(`setAgentWallet tx ${tx.hash ?? "(dry-run)"} — ${tx.status}`);
    if (tx.status !== "reverted") {
      rt.audit.append("agent:erc8004-linked", { agentId: agentId.toString(), via: "self", hash: tx.hash });
    }
    return;
  }

  const link = await registry.signWalletLink({ agentId, owner: configured });
  rt.audit.append("agent:erc8004-linked", {
    agentId: link.agentId,
    owner: link.owner,
    deadline: link.deadline,
    via: "operator",
  });

  let posted = false;
  try {
    await recordBackend(rt, {
      walletLink: { owner: link.owner, deadline: link.deadline, signature: link.signature },
    });
    posted = true;
  } catch (e) {
    out(`(could not hand the link to the backend: ${e instanceof Error ? e.message : String(e)})`);
  }

  out(`wallet link signed for agent ${link.agentId}`);
  out(`  wallet    ${link.newWallet}`);
  out(`  owner     ${link.owner}   ← must send the transaction`);
  out(`  expires   in ${link.ttlSecs}s (unix ${link.deadline})`);
  if (posted) {
    out("");
    out(`🔴 ${link.ttlSecs} seconds. The registry refuses any deadline more than 300s ahead,`);
    out("   so this signature is short-lived by design. Open the Terminal NOW:");
    out(
      rt.net.terminalBase
        ? `   ${rt.net.terminalBase}/settings → Agents → “Complete on-chain link”`
        : "   Trippy Terminal → Settings → Agents → “Complete on-chain link”",
    );
    out("   If it expires, just run `trippy-mcp identity link` again.");
  } else {
    out("");
    out("Hand these to the owner wallet to call setAgentWallet directly:");
    out(`   agentId ${link.agentId}`);
    out(`   wallet  ${link.newWallet}`);
    out(`   deadline ${link.deadline}`);
    out(`   signature ${link.signature}`);
  }
}

async function transferAction(
  rt: Runtime,
  registry: IdentityRegistry,
  argv: string[],
  out: (s: string) => void,
): Promise<void> {
  const agentId = await resolveAgentId(rt, argv);
  if (agentId === null) {
    out("no ERC-8004 identity recorded — run `trippy-mcp identity register` first.");
    process.exitCode = 1;
    return;
  }
  const to = rt.cfg.ownerSweepAddress as Address;
  const owner = await registry.ownerOf(agentId);
  if (owner.toLowerCase() === to.toLowerCase()) {
    out(`agent ${agentId} is already owned by ${to}`);
    return;
  }
  if (owner.toLowerCase() !== rt.signer.address.toLowerCase()) {
    out(`agent ${agentId} is owned by ${owner}, not this agent — nothing to transfer.`);
    process.exitCode = 1;
    return;
  }

  if (!argv.includes("--yes")) {
    out(`This transfers agent identity ${agentId} to ${to} — IRREVERSIBLE.`);
    out("");
    out("It also CLEARS agentWallet to 0x0 (the registry does this on every transfer),");
    out("so until the new owner submits a fresh wallet link this agent's trades are");
    out("not attributable to the identity. The link signature lives 300s, so plan on");
    out("running `trippy-mcp identity link` right after, with the Terminal open.");
    out("");
    out("Re-run with --yes to proceed.");
    process.exitCode = 1;
    return;
  }

  const tx = await registry.transfer(agentId, to);
  out(`transfer tx ${tx.hash ?? "(dry-run)"} — ${tx.status}`);
  if (tx.status === "reverted") {
    process.exitCode = 1;
    return;
  }
  rt.audit.append("agent:erc8004-transferred", { agentId: agentId.toString(), to, hash: tx.hash });
  if (tx.status !== "dry-run") {
    const view = await registry.view(agentId);
    out("");
    renderView(view, out);
    out("");
    out("Now run `trippy-mcp identity link` and complete it from the Terminal within 5 minutes.");
  }
}

// ---------------------------------------------------------------------------

/** Agent-key-signed write to the backend's `/agents/:address/erc8004`. */
async function recordBackend(
  rt: Runtime,
  body: { agentId?: string; walletLink?: { owner: string; deadline: number; signature: string } },
): Promise<void> {
  const address = rt.signer.address.toLowerCase();
  const chainId = rt.net.evmChainId;
  // The nonce request carries the SAME payload the write does, because the
  // server builds the signed message out of it and rebuilds it on submit.
  const summary = {
    ...(body.agentId ? { agentId: body.agentId } : {}),
    chainId,
    ...(body.walletLink
      ? { walletLink: { owner: body.walletLink.owner, deadline: body.walletLink.deadline } }
      : {}),
  };
  const { nonce, message } = await rt.pump.erc8004Nonce(address, summary);
  const signature = await rt.signer.account.signMessage({ message });
  await rt.pump.recordErc8004(address, {
    ...(body.agentId ? { agentId: body.agentId } : {}),
    chainId,
    ...(body.walletLink ? { walletLink: body.walletLink } : {}),
    nonce,
    signature,
  });
}
