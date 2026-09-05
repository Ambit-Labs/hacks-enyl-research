import { defineAgent } from "eve";

export default defineAgent({
  // Fixed in code. Never read this from an env var.
  model: "deepseek/deepseek-v4-flash-0731",
  // eve's AgentModelOptionsDefinition only forwards `providerOptions` (a
  // provider-specific passthrough); it does not expose a generic
  // temperature/CallSettings field, so there is no supported way to pin
  // temperature to 0 here. Left at the provider default.
  limits: {
    maxTokenCostUsdPerSession: 0.5,
    maxOutputTokensPerSession: 60_000,
    sessionTimeoutMs: 10 * 60 * 1000,
  },
});
