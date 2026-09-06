import { defineAgent } from "eve";
import { solverModel, solverContextWindowTokens } from "#lib/solver.ts";

export default defineAgent({
  // Fixed in code, never from an env var. SOLVER in agent/lib/solver.ts
  // defaults to "deepseek", which resolves to the literal model id
  // "deepseek/deepseek-v4-flash-0731" via the AI Gateway; that default is
  // also the scored submission. SOLVER can be switched by hand to a
  // research solver (ornith, teacher, ft9b, base9b) for a local run.
  model: solverModel(),
  // Ornith is not in the AI Gateway catalog, so eve needs this set by hand;
  // undefined for DeepSeek keeps the existing Gateway-catalog resolution.
  modelContextWindowTokens: solverContextWindowTokens(),
  // eve's AgentModelOptionsDefinition only forwards `providerOptions` (a
  // provider-specific passthrough); it does not expose a generic
  // temperature/CallSettings field, so there is no supported way to pin
  // temperature to 0 here. Left at the provider default.
  // Gateway routing for the DeepSeek id. The gateway spreads it across many
  // providers, and one of them (relace) returns tool calls as raw template
  // markup instead of structured calls (issue #8, probed 2026-09-05). Prefer
  // the two providers that probed clean and that the router itself favours,
  // allow the rest on error, never relace. No effect when SOLVER is
  // "ornith", since that model bypasses the gateway.
  modelOptions: {
    providerOptions: {
      gateway: {
        order: ["baseten", "runware"],
        only: [
          "baseten", "runware", "fireworks", "alibaba", "gmicloud",
          "togetherai", "particle", "parasail", "novita", "streamlake",
          "digitalocean", "deepinfra", "morph", "deepseek", "wafer",
          "inceptron", "runinfra",
        ],
      },
    },
  },
  limits: {
    maxTokenCostUsdPerSession: 0.5,
    maxOutputTokensPerSession: 60_000,
    sessionTimeoutMs: 10 * 60 * 1000,
  },
});
