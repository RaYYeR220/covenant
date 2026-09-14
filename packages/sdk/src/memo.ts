import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { CovenantKind, type CovenantKindValue } from "./covenants";

export const DEFAULT_VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export const DEFAULT_VENICE_MODEL = "llama-3.3-70b";

export interface PledgeTokenActivity {
  token: Address;
  transfersOut: number;
  transfersIn: number;
}

/** Proven, on-chain facts about a wallet — the only input the memo is allowed to reason over. */
export interface RiskProfile {
  wallet: Address;
  chainKey: number;
  provenRepays: number;
  breaches: number;
  currentAaveDebt?: bigint;
  pledgeTokenActivity?: PledgeTokenActivity[];
}

export interface ProposedTerm {
  kind: CovenantKindValue;
  chainKey: number;
  target: Address;
  threshold: bigint;
  rationale: string;
}

export interface RiskMemoOk {
  status: "ok";
  summary: string;
  riskFlags: string[];
  proposedTerms: ProposedTerm[];
  memoHash: Hex;
}

export interface RiskMemoUnavailable {
  status: "unavailable";
  reason: string;
}

export type RiskMemoResult = RiskMemoOk | RiskMemoUnavailable;

/**
 * Template bounds the memo's proposed terms can never exceed. These mirror the
 * contract's owner-configured ceilings/allowlists — the memo can only ever
 * tighten within them, never loosen or invent new targets.
 */
export interface MemoTemplateCeilings {
  maxThresholdByKind: Partial<Record<CovenantKindValue, bigint>>;
  /** Allowed `target` addresses per chainKey (Aave Pool for DEBT_CAP reserve scoping, pledge tokens for NEGATIVE_PLEDGE). Zero address (any) is always allowed. */
  allowlistedTargets: Record<number, Address[]>;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const VALID_KINDS: number[] = Object.values(CovenantKind);

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isAllowlisted(term: ProposedTerm, ceilings: MemoTemplateCeilings): boolean {
  if (term.target === ZERO_ADDRESS) return true;
  const allowed = ceilings.allowlistedTargets[term.chainKey] ?? [];
  return allowed.some((a) => sameAddress(a, term.target));
}

/**
 * HARD RULE: a proposed term whose threshold exceeds the template ceiling is
 * tightened down to that ceiling (never loosened); a term whose kind or
 * target is not allowlisted is dropped entirely. The memo/AI can never
 * expand what the borrower is allowed to do.
 */
export function clampProposedTerms(
  terms: ProposedTerm[],
  ceilings: MemoTemplateCeilings
): ProposedTerm[] {
  const out: ProposedTerm[] = [];
  for (const term of terms) {
    if (!VALID_KINDS.includes(term.kind)) continue;
    if (!isAllowlisted(term, ceilings)) continue;

    const ceiling = ceilings.maxThresholdByKind[term.kind];
    const threshold = ceiling !== undefined && term.threshold > ceiling ? ceiling : term.threshold;
    out.push({ ...term, threshold });
  }
  return out;
}

interface MemoContent {
  summary: string;
  riskFlags: string[];
  proposedTerms: Pick<ProposedTerm, "kind" | "chainKey" | "target" | "threshold" | "rationale">[];
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 0)
    .replace(/,/g, ",")
    .normalize();
}

function sortedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (value !== null && typeof value === "object" && typeof value !== "bigint") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortedCanonical(obj[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic keccak256 hash of the memo's canonical (key-sorted) JSON. */
export function computeMemoHash(memo: MemoContent): Hex {
  const canonical = canonicalJson(sortedCanonical(memo));
  return keccak256(stringToBytes(canonical));
}

const RawProposedTermSchema = z.object({
  kind: z.number().int().min(0).max(2),
  chainKey: z.number().int(),
  target: z.string(),
  threshold: z.union([z.string(), z.number()]),
  rationale: z.string()
});

const RawMemoSchema = z.object({
  summary: z.string(),
  riskFlags: z.array(z.string()),
  proposedTerms: z.array(RawProposedTermSchema)
});

function toProposedTerm(raw: z.infer<typeof RawProposedTermSchema>): ProposedTerm {
  return {
    kind: raw.kind as CovenantKindValue,
    chainKey: raw.chainKey,
    target: raw.target as Address,
    threshold: BigInt(raw.threshold),
    rationale: raw.rationale
  };
}

export interface GenerateRiskMemoOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  ceilings: MemoTemplateCeilings;
  fetch?: typeof fetch;
}

const RESPONSE_JSON_SCHEMA = {
  name: "covenant_risk_memo",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      riskFlags: { type: "array", items: { type: "string" } },
      proposedTerms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "integer" },
            chainKey: { type: "integer" },
            target: { type: "string" },
            threshold: { type: "string" },
            rationale: { type: "string" }
          },
          required: ["kind", "chainKey", "target", "threshold", "rationale"]
        }
      }
    },
    required: ["summary", "riskFlags", "proposedTerms"]
  }
} as const;

function unavailable(reason: string): RiskMemoUnavailable {
  return { status: "unavailable", reason };
}

async function pickModel(baseUrl: string, apiKey: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return DEFAULT_VENICE_MODEL;
    const body = (await res.json()) as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    // Prefer the largest well-known strong model available; fall back to default.
    const preferenceOrder = ["llama-3.1-405b", "llama-3.3-70b", "llama-3.1-70b"];
    for (const preferred of preferenceOrder) {
      if (ids.includes(preferred)) return preferred;
    }
    return ids[0] ?? DEFAULT_VENICE_MODEL;
  } catch {
    return DEFAULT_VENICE_MODEL;
  }
}

function buildPrompt(profile: RiskProfile): string {
  return [
    "You are a credit risk analyst for an under-collateralized lending protocol.",
    "Propose covenant terms based ONLY on the proven on-chain facts below.",
    "Covenant kinds: 0=CROSS_DEFAULT, 1=DEBT_CAP, 2=NEGATIVE_PLEDGE.",
    "Respond with strict JSON: {summary, riskFlags[], proposedTerms:[{kind,chainKey,target,threshold,rationale}]}.",
    `Proven facts: ${JSON.stringify(
      {
        wallet: profile.wallet,
        chainKey: profile.chainKey,
        provenRepays: profile.provenRepays,
        breaches: profile.breaches,
        currentAaveDebt: profile.currentAaveDebt?.toString(),
        pledgeTokenActivity: profile.pledgeTokenActivity
      },
      null,
      2
    )}`
  ].join("\n");
}

/**
 * Generates a risk memo via the Venice chat completions API.
 * Never fabricates a memo: any missing key, network failure, or schema
 * validation failure returns `{status:"unavailable"}` instead. Proposed terms
 * are always run through `clampProposedTerms` before being returned/hashed —
 * the memo can only ever tighten what the contract already allows.
 */
export async function generateRiskMemo(
  profile: RiskProfile,
  options: GenerateRiskMemoOptions
): Promise<RiskMemoResult> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    return unavailable("VENICE_API_KEY is not configured");
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_VENICE_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  try {
    const model = options.model ?? (await pickModel(baseUrl, apiKey, fetchImpl));

    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildPrompt(profile) }],
        response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA }
      })
    });

    if (!res.ok) {
      return unavailable(`Venice API returned HTTP ${res.status}`);
    }

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      return unavailable("Venice API returned no content");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return unavailable("model response was not valid JSON");
    }

    const parsed = RawMemoSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return unavailable(`model response failed schema validation: ${parsed.error.message}`);
    }

    const proposedTerms = clampProposedTerms(
      parsed.data.proposedTerms.map(toProposedTerm),
      options.ceilings
    );

    const memoContent: MemoContent = {
      summary: parsed.data.summary,
      riskFlags: parsed.data.riskFlags,
      proposedTerms
    };

    return {
      status: "ok",
      summary: memoContent.summary,
      riskFlags: memoContent.riskFlags,
      proposedTerms,
      memoHash: computeMemoHash(memoContent)
    };
  } catch (err) {
    return unavailable(`Venice API call failed: ${String(err)}`);
  }
}
