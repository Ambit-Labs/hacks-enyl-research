// Solver model selection. "deepseek" is the committed default and the one
// the scored submission runs on. Switch by hand for a research run; the run
// directory name (e.g. runs/r02-ornith-fails) records which value produced
// it. No env var chooses the model at runtime, per the project's hard rules.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

export const SOLVER: "deepseek" | "ornith" | "teacher" | "ft9b" | "base9b" = "deepseek";

// The #13 worker found that at temperature 0 Ornith's reasoning never
// terminates on non-trivial prompts (it burns the whole output budget and
// returns empty content). Variant A keeps thinking on with the model card's
// recommended temperature 0.6; variant B turns thinking off via vLLM's
// chat_template_kwargs and keeps temperature 0. Smoke-test A first; fall
// back to B only if tasks still run long or overflow context.
export const ORNITH_VARIANT: "A" | "B" = "A";

// Same AI Gateway id used by agent/agent.ts before this experiment.
const DEEPSEEK_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

// Model name is a literal, per the hard rules. Only the endpoint and key
// come from the environment.
const ORNITH_MODEL_NAME = "Ornith-1.5-35B-A3B";

// Issue #16: a stronger model over OpenRouter, used to generate teacher
// trajectories for the 9B fine-tune on the 58 tasks DeepSeek fails. Chosen
// from `GET /models` on 2026-09-05 in preference order (claude-sonnet-4.5 >
// gpt-5 > gemini-2.5-pro); all three were available, so this is
// claude-sonnet-4.5. Literal per the hard rules; only the key comes from the
// environment.
const TEACHER_MODEL_NAME = "anthropic/claude-sonnet-4.5";

// Issue #16: the held-out evaluation of the fine-tuned Ornith 9B against the
// untuned 9B base it started from. Both are served over vLLM on the same
// Runcrate box, thinking off, so they compare apples to apples with Ornith
// variant B above. Model names are literals per the hard rules; only the
// endpoints and key come from the environment.
const FT9B_MODEL_NAME = "Ornith-9B-ft";
const BASE9B_MODEL_NAME = "Ornith-1.5-9B-base";

// eve strips modelOptions.providerOptions before a provider-authored
// LanguageModel reaches the wire (it only forwards that field for a gateway
// model id), so the vLLM extra-body field and the temperature for the
// non-default variant have to ride on the model object itself. This
// middleware merges them into every call's params.
function ornithVariantMiddleware(variant: "A" | "B"): LanguageModelMiddleware {
  const enableThinking = variant === "A";
  const temperature = variant === "A" ? 0.6 : 0;
  return {
    transformParams: async ({ params }) => ({
      ...params,
      temperature,
      providerOptions: {
        ...params.providerOptions,
        ornith: {
          ...params.providerOptions?.ornith,
          chat_template_kwargs: { enable_thinking: enableThinking },
        },
      },
    }),
  };
}

function ornithModel(): LanguageModel {
  const baseURL = process.env.ORNITH_BASE_URL;
  const apiKey = process.env.ORNITH_API_KEY;
  if (!baseURL) throw new Error("ORNITH_BASE_URL is not set");
  if (!apiKey) throw new Error("ORNITH_API_KEY is not set");
  const ornith = createOpenAICompatible({
    name: "ornith",
    baseURL,
    apiKey,
  });
  return wrapLanguageModel({
    model: ornith(ORNITH_MODEL_NAME),
    middleware: ornithVariantMiddleware(ORNITH_VARIANT),
  });
}

function teacherModel(): LanguageModel {
  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) throw new Error("OPEN_ROUTER_API_KEY is not set");
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });
  return openrouter(TEACHER_MODEL_NAME);
}

// Thinking off via chat_template_kwargs, same as Ornith variant B, at
// temperature 0.
function thinkingOffMiddleware(): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => ({
      ...params,
      temperature: 0,
      providerOptions: {
        ...params.providerOptions,
        ornith: {
          ...params.providerOptions?.ornith,
          chat_template_kwargs: { enable_thinking: false },
        },
      },
    }),
  };
}

function nineBModel(
  name: string,
  baseURLEnv: string,
  apiKeyEnv: string,
): LanguageModel {
  const baseURL = process.env[baseURLEnv];
  const apiKey = process.env[apiKeyEnv];
  if (!baseURL) throw new Error(`${baseURLEnv} is not set`);
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set`);
  const provider = createOpenAICompatible({
    name: "ornith",
    baseURL,
    apiKey,
  });
  return wrapLanguageModel({
    model: provider(name),
    middleware: thinkingOffMiddleware(),
  });
}

function ft9bModel(): LanguageModel {
  return nineBModel(FT9B_MODEL_NAME, "FT9B_BASE_URL", "FT9B_API_KEY");
}

function base9bModel(): LanguageModel {
  return nineBModel(BASE9B_MODEL_NAME, "FT9B_BASE_URL_BASE", "FT9B_API_KEY");
}

// Returns the gateway id string for DeepSeek, or a provider-authored
// LanguageModel for Ornith, the teacher, or the 9B fine-tune/base pair,
// depending on SOLVER.
export function solverModel(): string | LanguageModel {
  if (SOLVER === "ornith") return ornithModel();
  if (SOLVER === "teacher") return teacherModel();
  if (SOLVER === "ft9b") return ft9bModel();
  if (SOLVER === "base9b") return base9bModel();
  return DEEPSEEK_MODEL_ID;
}

// The label scripts/traces.ts records as "model" on every trace line. A
// provider-authored LanguageModel object carries no gateway id string eve
// can report at runtime, so trace labeling can't follow the model the way
// it did when agent.ts held one literal; this keeps it a single source
// instead of a second hand-copied constant in traces.ts.
export function solverModelLabel(): string {
  if (SOLVER === "ornith") return ORNITH_MODEL_NAME;
  if (SOLVER === "teacher") return TEACHER_MODEL_NAME;
  if (SOLVER === "ft9b") return FT9B_MODEL_NAME;
  if (SOLVER === "base9b") return BASE9B_MODEL_NAME;
  return DEEPSEEK_MODEL_ID;
}

// Ornith is not in the AI Gateway catalog, so eve cannot resolve its context
// window automatically; it must be set explicitly (agent-config.md, "Choose
// the model dynamically"). ORNITH_BASE_URL now points at a proxy in front of
// several Runcrate boxes with mixed --max-model-len (65536 on most, 131072
// on one), so this stays at the smallest common value: it only governs when
// eve compacts, and understating it costs some context headroom on the
// bigger boxes, while overstating it would let a request through that a
// 65536 backend then rejects. Edit by hand alongside ORNITH_BASE_URL.
// Undefined for DeepSeek lets eve keep resolving that from the Gateway
// catalog as before.
// OpenRouter lists a 1M-token context for claude-sonnet-4.5, but that is the
// beta 1M-context tier; the standard tier this call uses is 200k. Stating
// the smaller number only costs some headroom before eve compacts, while
// the larger one would let a request through that the standard tier then
// rejects. Undefined for DeepSeek lets eve keep resolving that from the
// Gateway catalog as before; ornith keeps its own value.
export function solverContextWindowTokens(): number | undefined {
  if (SOLVER === "ornith") return 65536;
  if (SOLVER === "teacher") return 200_000;
  // scripts/ft9b/serve_ft9b.sh serves both the fine-tune and the base model
  // at --max-model-len 32768; stating 131072 here would let eve send a
  // request past what the vLLM backend accepts.
  if (SOLVER === "ft9b" || SOLVER === "base9b") return 32_768;
  return undefined;
}
