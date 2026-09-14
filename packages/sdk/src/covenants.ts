import { decodeAbiParameters, type Address } from "viem";
import type { DecodedLog } from "./decoder";
import { AAVE_POOL_ADDRESS, type AttestcoinChainKey } from "./chains";

/** Covenant kinds, matching the Solidity `enum` in CovenantManager. */
export const CovenantKind = {
  CROSS_DEFAULT: 0,
  DEBT_CAP: 1,
  NEGATIVE_PLEDGE: 2
} as const;

export type CovenantKindValue = (typeof CovenantKind)[keyof typeof CovenantKind];

/** Weight each covenant kind contributes to the borrowing limit, in bps. */
export const COVENANT_WEIGHT_BPS: Record<CovenantKindValue, number> = {
  [CovenantKind.CROSS_DEFAULT]: 10000,
  [CovenantKind.DEBT_CAP]: 7500,
  [CovenantKind.NEGATIVE_PLEDGE]: 5000
};

export const HISTORY_BOOST_BPS_PER_REPAY = 2500;
export const HISTORY_BOOST_MAX_BPS = 10000;
export const DEFAULT_MAX_LEVERAGE_BPS = 40000;
export const BPS_DENOMINATOR = 10000;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// Event signature hashes (verified against real Aave V3 / ERC20 fixture logs).
export const LIQUIDATION_CALL_TOPIC0 =
  "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286" as const;
export const BORROW_TOPIC0 =
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as const;
export const REPAY_TOPIC0 =
  "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051" as const;
export const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export interface CovenantTermLike {
  kind: CovenantKindValue;
  retired?: boolean;
}

export interface ComputeLimitParams {
  maxLeverageBps?: number;
  perLineCap?: bigint;
}

/**
 * Mirrors `CovenantManager.limitOf`: bond amplified by the sum of active term
 * weights plus a history boost (2500 bps per proven repay, capped at 10000 bps),
 * bounded by maxLeverageBps and an optional perLineCap.
 */
export function computeLimit(
  bond: bigint,
  terms: CovenantTermLike[],
  historyRepays: number,
  params: ComputeLimitParams = {}
): bigint {
  const maxLeverageBps = params.maxLeverageBps ?? DEFAULT_MAX_LEVERAGE_BPS;

  const weightSum = terms
    .filter((t) => !t.retired)
    .reduce((sum, t) => sum + COVENANT_WEIGHT_BPS[t.kind], 0);

  const historyBoost = Math.min(
    historyRepays * HISTORY_BOOST_BPS_PER_REPAY,
    HISTORY_BOOST_MAX_BPS
  );

  const weighted =
    (bond * BigInt(BPS_DENOMINATOR + weightSum + historyBoost)) / BigInt(BPS_DENOMINATOR);
  const leverageCapped = (bond * BigInt(maxLeverageBps)) / BigInt(BPS_DENOMINATOR);

  let limit = weighted < leverageCapped ? weighted : leverageCapped;
  if (params.perLineCap !== undefined && params.perLineCap < limit) {
    limit = params.perLineCap;
  }
  return limit;
}

export interface PredicateTerm {
  chainKey: AttestcoinChainKey | number;
  target: Address;
  threshold: bigint;
}

export interface PredicateResult {
  breach: boolean;
  amount: bigint;
  reason: string;
}

export interface MatchResult {
  matches: boolean;
  amount: bigint;
  reason: string;
}

/** Decodes an indexed address topic as `address(uint160(uint256(topic)))`. */
function topicToAddress(topic: string): Address {
  return `0x${topic.slice(-40)}` as Address;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function aavePoolFor(chainKey: number): Address | undefined {
  return AAVE_POOL_ADDRESS[chainKey as AttestcoinChainKey];
}

/**
 * Pure mirror of the CovenantManager breach predicates. Emitter binding is
 * checked first (topic0 alone is spoofable) before any topic/data decoding.
 */
export function matchBreach(
  kind: CovenantKindValue,
  term: PredicateTerm,
  wallet: Address,
  log: DecodedLog
): PredicateResult {
  switch (kind) {
    case CovenantKind.CROSS_DEFAULT: {
      const pool = aavePoolFor(term.chainKey);
      if (!pool || !sameAddress(log.address, pool)) {
        return { breach: false, amount: 0n, reason: "emitter is not the registered Aave Pool" };
      }
      if (log.topics[0] !== LIQUIDATION_CALL_TOPIC0) {
        return { breach: false, amount: 0n, reason: "topic0 is not LiquidationCall" };
      }
      const user = topicToAddress(log.topics[3]);
      if (!sameAddress(user, wallet)) {
        return { breach: false, amount: 0n, reason: "liquidated user does not match linked wallet" };
      }
      const [debtToCover] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bool" }],
        log.data as `0x${string}`
      ) as [bigint, bigint, Address, boolean];
      return { breach: true, amount: debtToCover, reason: "CROSS_DEFAULT: liquidation of linked wallet" };
    }

    case CovenantKind.DEBT_CAP: {
      const pool = aavePoolFor(term.chainKey);
      if (!pool || !sameAddress(log.address, pool)) {
        return { breach: false, amount: 0n, reason: "emitter is not the registered Aave Pool" };
      }
      if (log.topics[0] !== BORROW_TOPIC0) {
        return { breach: false, amount: 0n, reason: "topic0 is not Borrow" };
      }
      const reserve = topicToAddress(log.topics[1]);
      const onBehalfOf = topicToAddress(log.topics[2]);
      if (term.target !== ZERO_ADDRESS && !sameAddress(reserve, term.target)) {
        return { breach: false, amount: 0n, reason: "reserve does not match term target" };
      }
      if (!sameAddress(onBehalfOf, wallet)) {
        return { breach: false, amount: 0n, reason: "onBehalfOf does not match linked wallet" };
      }
      const [, amount] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }],
        log.data as `0x${string}`
      ) as [Address, bigint, number, bigint];
      if (amount <= term.threshold) {
        return { breach: false, amount, reason: "borrow amount does not exceed threshold" };
      }
      return { breach: true, amount, reason: "DEBT_CAP: borrow exceeds threshold" };
    }

    case CovenantKind.NEGATIVE_PLEDGE: {
      if (!sameAddress(log.address, term.target)) {
        return { breach: false, amount: 0n, reason: "emitter is not the pledged token" };
      }
      if (log.topics[0] !== TRANSFER_TOPIC0) {
        return { breach: false, amount: 0n, reason: "topic0 is not Transfer" };
      }
      const from = topicToAddress(log.topics[1]);
      if (!sameAddress(from, wallet)) {
        return { breach: false, amount: 0n, reason: "transfer sender does not match linked wallet" };
      }
      const [value] = decodeAbiParameters(
        [{ type: "uint256" }],
        log.data as `0x${string}`
      ) as [bigint];
      if (value <= term.threshold) {
        return { breach: false, amount: value, reason: "transfer value does not exceed threshold" };
      }
      return { breach: true, amount: value, reason: "NEGATIVE_PLEDGE: transfer out of linked wallet exceeds threshold" };
    }

    default:
      return { breach: false, amount: 0n, reason: "unknown covenant kind" };
  }
}

/** Pure mirror of the Aave Repay predicate used for history proofs and DEBT_CAP cures. */
export function matchRepay(chainKey: number, wallet: Address, log: DecodedLog): MatchResult {
  const pool = aavePoolFor(chainKey);
  if (!pool || !sameAddress(log.address, pool)) {
    return { matches: false, amount: 0n, reason: "emitter is not the registered Aave Pool" };
  }
  if (log.topics[0] !== REPAY_TOPIC0) {
    return { matches: false, amount: 0n, reason: "topic0 is not Repay" };
  }
  const user = topicToAddress(log.topics[2]);
  if (!sameAddress(user, wallet)) {
    return { matches: false, amount: 0n, reason: "repay user does not match linked wallet" };
  }
  const [amount] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }],
    log.data as `0x${string}`
  ) as [bigint, boolean];
  return { matches: true, amount, reason: "proven Aave Repay by linked wallet" };
}

/**
 * Pure mirror of the cure predicates. CROSS_DEFAULT can never be cured by
 * proof (only full repayment cures it), matching the spec.
 */
export function matchCure(
  kind: CovenantKindValue,
  term: PredicateTerm,
  wallet: Address,
  log: DecodedLog,
  breachAmount: bigint
): MatchResult {
  if (kind === CovenantKind.CROSS_DEFAULT) {
    return { matches: false, amount: 0n, reason: "CROSS_DEFAULT is not curable by proof" };
  }

  if (kind === CovenantKind.DEBT_CAP) {
    const pool = aavePoolFor(term.chainKey);
    if (!pool || !sameAddress(log.address, pool)) {
      return { matches: false, amount: 0n, reason: "emitter is not the registered Aave Pool" };
    }
    if (log.topics[0] !== REPAY_TOPIC0) {
      return { matches: false, amount: 0n, reason: "topic0 is not Repay" };
    }
    const reserve = topicToAddress(log.topics[1]);
    const user = topicToAddress(log.topics[2]);
    if (term.target !== ZERO_ADDRESS && !sameAddress(reserve, term.target)) {
      return { matches: false, amount: 0n, reason: "reserve does not match term target" };
    }
    if (!sameAddress(user, wallet)) {
      return { matches: false, amount: 0n, reason: "repay user does not match linked wallet" };
    }
    const [amount] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }],
      log.data as `0x${string}`
    ) as [bigint, boolean];
    if (amount < breachAmount) {
      return { matches: false, amount, reason: "repay amount is less than the breach amount" };
    }
    return { matches: true, amount, reason: "DEBT_CAP cured by sufficient repay" };
  }

  // NEGATIVE_PLEDGE
  if (!sameAddress(log.address, term.target)) {
    return { matches: false, amount: 0n, reason: "emitter is not the pledged token" };
  }
  if (log.topics[0] !== TRANSFER_TOPIC0) {
    return { matches: false, amount: 0n, reason: "topic0 is not Transfer" };
  }
  const to = topicToAddress(log.topics[2]);
  if (!sameAddress(to, wallet)) {
    return { matches: false, amount: 0n, reason: "transfer recipient does not match linked wallet" };
  }
  const [value] = decodeAbiParameters(
    [{ type: "uint256" }],
    log.data as `0x${string}`
  ) as [bigint];
  if (value < breachAmount) {
    return { matches: false, amount: value, reason: "returned amount is less than the breach amount" };
  }
  return { matches: true, amount: value, reason: "NEGATIVE_PLEDGE cured by sufficient transfer back" };
}
