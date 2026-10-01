/**
 * The UniversalRouter swap plan — built HERE, from pinned addresses and an
 * on-chain quote, and checked again before it is signed.
 *
 * 🔴 Why local: the Choice v2 frontend signs whatever calldata `/route` hands
 * it. A compromised API could then hand back a plan that pays the output to
 * itself, or one that spends the Permit2 allowance on something else, and the
 * frontend would sign it. This package never signs calldata it did not build,
 * and `assertSafePlan` re-decodes what it built against the request — the same
 * check that would gate an API-built plan, applied to our own, so an encoding
 * bug fails closed instead of signing.
 *
 * Shapes, single-hop CL exact-in only (all a launch or DojoFun pool needs):
 *
 *   native → token   WRAP_ETH(router, amountIn)
 *                    INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE,
 *                               SETTLE(wINJ, amountIn, payerIsUser=false),
 *                               TAKE_ALL(token, minOut) ]
 *   token → native   INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE,
 *                               SETTLE_ALL(token, amountIn),
 *                               TAKE(wINJ, router, OPEN_DELTA) ]
 *                    UNWRAP_WETH(msg.sender, minOut)
 *   erc20 → erc20    INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE,
 *                               SETTLE_ALL(tokenIn, amountIn),
 *                               TAKE_ALL(tokenOut, minOut) ]
 *
 * SETTLE_ALL pulls from `msg.sender` through Permit2; TAKE_ALL pays
 * `msg.sender`. Every amount is explicit, never CONTRACT_BALANCE: a partial fill
 * leaves the vault unsettled and the whole transaction reverts, rather than
 * stranding the difference in the router for the next caller to sweep.
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from "viem";

import { ToolError } from "../../errors.js";
import { POOL_KEY_COMPONENTS, UNIVERSAL_ROUTER_ABI } from "./abi.js";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
}

/** UniversalRouter commands (src/libraries/Commands.sol). */
export const Command = {
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  INFI_SWAP: 0x10,
} as const;

/** Infinity periphery actions (src/libraries/Actions.sol). */
export const Action = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/** ActionConstants: router-relative recipients and the open-delta sentinel. */
export const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
export const OPEN_DELTA = 0n;

const UINT128_MAX = (1n << 128n) - 1n;
const POOL_KEY_TUPLE = { type: "tuple", components: POOL_KEY_COMPONENTS } as const;
const SWAP_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", ...POOL_KEY_TUPLE },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;
const ADDR_UINT = [{ type: "address" }, { type: "uint256" }] as const;
const ADDR_UINT_BOOL = [{ type: "address" }, { type: "uint256" }, { type: "bool" }] as const;
const ADDR_ADDR_UINT = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;
const ACTIONS_ROUTER = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/** `PoolId` = keccak256(abi.encode(PoolKey)) — what CLPoolManager keys a pool by. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_TUPLE], [key]));
}

export interface SwapRequest {
  key: PoolKey;
  /** What leaves the wallet: the native coin when `nativeIn`, else an ERC20. */
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** The floor, from the on-chain quote and the caller's slippage. */
  minOut: bigint;
  /** Pay with native INJ (wrapped to wINJ inside the router). */
  nativeIn: boolean;
  /** Receive native INJ (wINJ unwrapped inside the router). */
  nativeOut: boolean;
  winj: Address;
}

export interface SwapPlan {
  commands: Hex;
  inputs: Hex[];
  /** `msg.value`: the native amount in, else 0. */
  value: bigint;
}

function currencyIn(r: SwapRequest): Address {
  return r.nativeIn ? r.winj : r.tokenIn;
}
function currencyOut(r: SwapRequest): Address {
  return r.nativeOut ? r.winj : r.tokenOut;
}

/** Which way the swap crosses the pool: true when selling currency0. */
export function zeroForOneOf(key: PoolKey, inCurrency: Address): boolean {
  const c = inCurrency.toLowerCase();
  if (c === key.currency0.toLowerCase()) return true;
  if (c === key.currency1.toLowerCase()) return false;
  throw new ToolError("bad_pool", `${inCurrency} is not a currency of this pool`);
}

export function buildSwapPlan(r: SwapRequest): SwapPlan {
  if (r.nativeIn && r.nativeOut) throw new ToolError("bad_input", "native in and native out is not a swap");
  if (r.amountIn <= 0n || r.amountIn > UINT128_MAX) throw new ToolError("bad_amount", "amountIn out of range");
  if (r.minOut <= 0n || r.minOut > UINT128_MAX) throw new ToolError("bad_amount", "minOut out of range");
  const cin = currencyIn(r);
  const cout = currencyOut(r);
  const zeroForOne = zeroForOneOf(r.key, cin);
  // The output has to be the pool's OTHER currency, or the plan takes nothing.
  const other = zeroForOne ? r.key.currency1 : r.key.currency0;
  if (other.toLowerCase() !== cout.toLowerCase()) {
    throw new ToolError("bad_pool", `${cout} is not the other side of this pool`);
  }

  const swap = encodeAbiParameters(SWAP_PARAMS, [
    { poolKey: r.key, zeroForOne, amountIn: r.amountIn, amountOutMinimum: r.minOut, hookData: "0x" },
  ]);
  const settle = r.nativeIn
    ? encodeAbiParameters(ADDR_UINT_BOOL, [cin, r.amountIn, false])
    : encodeAbiParameters(ADDR_UINT, [cin, r.amountIn]);
  const take = r.nativeOut
    ? encodeAbiParameters(ADDR_ADDR_UINT, [cout, ADDRESS_THIS, OPEN_DELTA])
    : encodeAbiParameters(ADDR_UINT, [cout, r.minOut]);
  const actions = bytesOf([
    Action.CL_SWAP_EXACT_IN_SINGLE,
    r.nativeIn ? Action.SETTLE : Action.SETTLE_ALL,
    r.nativeOut ? Action.TAKE : Action.TAKE_ALL,
  ]);
  const infi = encodeAbiParameters(ACTIONS_ROUTER, [actions, [swap, settle, take]]);

  const commands: number[] = [];
  const inputs: Hex[] = [];
  if (r.nativeIn) {
    commands.push(Command.WRAP_ETH);
    inputs.push(encodeAbiParameters(ADDR_UINT, [ADDRESS_THIS, r.amountIn]));
  }
  commands.push(Command.INFI_SWAP);
  inputs.push(infi);
  if (r.nativeOut) {
    commands.push(Command.UNWRAP_WETH);
    inputs.push(encodeAbiParameters(ADDR_UINT, [MSG_SENDER, r.minOut]));
  }
  return { commands: bytesOf(commands), inputs, value: r.nativeIn ? r.amountIn : 0n };
}

/** Full `execute(commands, inputs, deadline)` calldata. */
export function executeCalldata(plan: SwapPlan, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [plan.commands, plan.inputs, deadline],
  });
}

export interface PlanExpectation {
  to: Address;
  router: Address;
  amountIn: bigint;
  /** Our own floor: the plan may demand more, never less. */
  minOutFloor: bigint;
  tokenIn: Address;
  tokenOut: Address;
  nativeIn: boolean;
  nativeOut: boolean;
  winj: Address;
  /** Hooks a swapped pool may carry (zero address = hookless, always allowed). */
  allowedHooks: readonly Address[];
  /** The ONLY pool manager a key may name. */
  poolManager: Address;
}

/**
 * Decode `execute` calldata and refuse anything but the plan we meant.
 *
 * Every rule here is one way a plan could move money that the request did not:
 * an extra command (a SWEEP or TRANSFER to someone else), a recipient that is
 * not the caller or the router, an input larger than asked, a floor lower than
 * the quote's, a pool behind an unknown hook or a foreign pool manager, a
 * `value` that is not exactly the native amount.
 */
export function assertSafePlan(calldata: Hex, value: bigint, e: PlanExpectation): void {
  const fail = (why: string): never => {
    throw new ToolError("unsafe_plan", `refusing to sign this Choice v2 swap: ${why}`);
  };
  if (e.to.toLowerCase() !== e.router.toLowerCase()) fail(`target ${e.to} is not the UniversalRouter`);

  let commands: Hex;
  let inputs: readonly Hex[];
  try {
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: calldata });
    if (d.functionName !== "execute") fail(`unexpected function ${d.functionName}`);
    [commands, inputs] = d.args as unknown as [Hex, readonly Hex[], bigint];
  } catch (err) {
    if (err instanceof ToolError) throw err;
    return fail("calldata does not decode as execute(bytes,bytes[],uint256)");
  }

  const cmds = hexBytes(commands);
  const want = [
    ...(e.nativeIn ? [Command.WRAP_ETH] : []),
    Command.INFI_SWAP,
    ...(e.nativeOut ? [Command.UNWRAP_WETH] : []),
  ];
  // FLAG_ALLOW_REVERT (0x80) is not in `want`, so a command carrying it fails here.
  if (cmds.length !== want.length || cmds.some((c, i) => c !== want[i])) {
    fail(`commands [${cmds.map(hex2).join(",")}] are not [${want.map(hex2).join(",")}]`);
  }
  if (inputs.length !== cmds.length) fail("inputs do not match commands");
  if (value !== (e.nativeIn ? e.amountIn : 0n)) fail(`value ${value} is not the native amount in`);

  const cin = (e.nativeIn ? e.winj : e.tokenIn).toLowerCase();
  const cout = (e.nativeOut ? e.winj : e.tokenOut).toLowerCase();
  let i = 0;

  if (e.nativeIn) {
    const [to, amount] = decodeAbiParameters(ADDR_UINT, inputs[i++]!);
    if (to.toLowerCase() !== ADDRESS_THIS) fail("WRAP_ETH must wrap into the router");
    if (amount !== e.amountIn) fail(`WRAP_ETH amount ${amount} is not ${e.amountIn}`);
  }

  const [actionsHex, params] = decodeAbiParameters(ACTIONS_ROUTER, inputs[i++]!);
  const actions = hexBytes(actionsHex);
  const wantActions = [
    Action.CL_SWAP_EXACT_IN_SINGLE,
    e.nativeIn ? Action.SETTLE : Action.SETTLE_ALL,
    e.nativeOut ? Action.TAKE : Action.TAKE_ALL,
  ];
  if (actions.length !== 3 || actions.some((a, j) => a !== wantActions[j]) || params.length !== 3) {
    fail(`actions [${actions.map(hex2).join(",")}] are not [${wantActions.map(hex2).join(",")}]`);
  }

  const [swap] = decodeAbiParameters(SWAP_PARAMS, params[0]!);
  const key = swap.poolKey;
  const hooks = key.hooks.toLowerCase();
  if (hooks !== ZERO && !e.allowedHooks.some((h) => h.toLowerCase() === hooks)) {
    fail(`pool hook ${key.hooks} is not an allowed hook`);
  }
  if (key.poolManager.toLowerCase() !== e.poolManager.toLowerCase()) {
    fail(`pool manager ${key.poolManager} is not Choice v2's CLPoolManager`);
  }
  const swapIn = (swap.zeroForOne ? key.currency0 : key.currency1).toLowerCase();
  const swapOut = (swap.zeroForOne ? key.currency1 : key.currency0).toLowerCase();
  if (swapIn !== cin || swapOut !== cout) fail("the swap does not trade the requested pair");
  if (swap.amountIn !== e.amountIn) fail(`swap amountIn ${swap.amountIn} is not ${e.amountIn}`);
  if (swap.amountOutMinimum < e.minOutFloor) fail(`swap floor ${swap.amountOutMinimum} is under ${e.minOutFloor}`);
  if (swap.hookData !== "0x") fail("unexpected hookData");

  if (e.nativeIn) {
    const [c, amount, payerIsUser] = decodeAbiParameters(ADDR_UINT_BOOL, params[1]!);
    if (c.toLowerCase() !== cin || amount !== e.amountIn || payerIsUser) fail("SETTLE is not the wrapped input");
  } else {
    const [c, max] = decodeAbiParameters(ADDR_UINT, params[1]!);
    if (c.toLowerCase() !== cin || max !== e.amountIn) fail("SETTLE_ALL is not the exact input");
  }

  if (e.nativeOut) {
    const [c, to, amount] = decodeAbiParameters(ADDR_ADDR_UINT, params[2]!);
    if (c.toLowerCase() !== cout || to.toLowerCase() !== ADDRESS_THIS || amount !== OPEN_DELTA) {
      fail("TAKE must take the whole wrapped output into the router");
    }
    const [to2, amountMin] = decodeAbiParameters(ADDR_UINT, inputs[i++]!);
    if (to2.toLowerCase() !== MSG_SENDER) fail("UNWRAP_WETH must pay the caller");
    if (amountMin < e.minOutFloor) fail(`UNWRAP_WETH floor ${amountMin} is under ${e.minOutFloor}`);
  } else {
    const [c, min] = decodeAbiParameters(ADDR_UINT, params[2]!);
    if (c.toLowerCase() !== cout) fail("TAKE_ALL takes the wrong currency");
    if (min < e.minOutFloor) fail(`TAKE_ALL floor ${min} is under ${e.minOutFloor}`);
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

function bytesOf(xs: number[]): Hex {
  return `0x${xs.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function hexBytes(h: Hex): number[] {
  const s = h.slice(2);
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}
function hex2(x: number): string {
  return `0x${x.toString(16).padStart(2, "0")}`;
}
