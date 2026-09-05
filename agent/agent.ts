import { defineAgent } from "eve";

export default defineAgent({
  // Fixed in code. Never read this from an env var.
  model: "deepseek/deepseek-v4-flash-0731",
  // eve's AgentModelOptionsDefinition only forwards `providerOptions` (a
  // provider-specific passthrough); it does not expose a generic
  // temperature/CallSettings field, so there is no supported way to pin
  // temperature to 0 here. Left at the provider default.
  // Gateway routing. The gateway spreads this model id across many
  // providers, and one of them (relace) returns tool calls as raw template
  // markup instead of structured calls (issue #8, probed 2026-09-05). Prefer
  // the two providers that probed clean and that the router itself favours,
  // allow the rest on error, never relace. The model id above is unchanged.
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
