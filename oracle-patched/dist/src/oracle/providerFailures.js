import { OracleTransportError, asOracleUserError } from "./errors.js";
import { buildProviderRoutePlan } from "./providerRoutePlan.js";
export function classifyProviderFailure(error, context) {
    const userError = asOracleUserError(error);
    if (userError) {
        return null;
    }
    const normalizedContext = normalizeContext(context);
    const route = inferFailureRoute(normalizedContext);
    const rawProviderMessage = extractProviderMessage(error);
    const lower = rawProviderMessage.toLowerCase();
    const category = classifyMessage(lower, error);
    if (!category) {
        return null;
    }
    const providerMessage = sanitizeProviderMessage(rawProviderMessage);
    return {
        category,
        label: labelForCategory(category),
        provider: route.provider,
        keyEnv: route.keySource,
        providerMessage,
        fix: fixForCategory(category, route.provider, normalizedContext.model, route.keySource),
    };
}
function classifyMessage(lower, error) {
    if (isLocalPermissionError(error, lower)) {
        return null;
    }
    if (lower.includes("expired") &&
        (lower.includes("api key") || lower.includes("credential") || lower.includes("token"))) {
        return "auth-expired";
    }
    if (lower.includes("invalid x-api-key") ||
        lower.includes("invalid api key") ||
        lower.includes("api key is invalid") ||
        lower.includes("api key not valid") ||
        lower.includes("incorrect api key") ||
        lower.includes("unauthorized") ||
        lower.includes("unauthenticated") ||
        hasStatusCode(lower, "401")) {
        return "auth-failed";
    }
    if (lower.includes("insufficient_quota") ||
        lower.includes("quota exceeded") ||
        lower.includes("billing") ||
        lower.includes("resource_exhausted")) {
        return "quota-exceeded";
    }
    if (lower.includes("rate limit") || lower.includes("rate_limit") || hasStatusCode(lower, "429")) {
        return "rate-limited";
    }
    if (error instanceof OracleTransportError && error.reason === "model-unavailable") {
        return "model-unavailable";
    }
    if (lower.includes("model not available") ||
        lower.includes("model_not_found") ||
        lower.includes("unknown model") ||
        lower.includes("does not exist")) {
        return "model-unavailable";
    }
    return null;
}
function hasStatusCode(lower, status) {
    return new RegExp(`(^|\\D)${status}(\\D|$)`).test(lower);
}
function isLocalPermissionError(error, lower) {
    const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code).toUpperCase()
        : "";
    return (code === "EACCES" ||
        code === "EPERM" ||
        lower.includes("eacces:") ||
        lower.includes("eperm:") ||
        /permission denied, (open|scandir|mkdir|access|unlink|rename)\b/.test(lower));
}
function extractProviderMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function sanitizeProviderMessage(message) {
    return message
        .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]")
        .replace(/\b(api[-_ ]?key\s+provided)(\s*[:=]?\s*)["']?[^"',;\s]+/gi, "$1$2[redacted]")
        .replace(/\b(api[-_ ]?key|x-api-key|authorization|token)(\s*[:=]\s*)["']?[^"',;\s]+/gi, "$1$2[redacted]")
        .replace(/\bsk-(?:ant-|or-)?[A-Za-z0-9_-]{8,}\b/g, "sk-...[redacted]")
        .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, "xai-...[redacted]")
        .replace(/\bAIza[0-9A-Za-z_-]{8,}\b/g, "AIza...[redacted]");
}
function normalizeContext(context) {
    if (typeof context === "string") {
        return { model: context };
    }
    return context ?? {};
}
function inferFailureRoute(context) {
    if (context.model) {
        const plan = buildProviderRoutePlan({
            model: context.model,
            providerMode: context.providerMode,
            azure: context.azure,
            baseUrl: context.baseUrl,
            apiKey: context.apiKey,
            env: context.env,
        });
        const keySource = normalizeKeySource(plan.keySource);
        if (plan.providerLabel === "OpenRouter" || plan.keySource.includes("OPENROUTER_API_KEY")) {
            return { provider: "openrouter", keySource };
        }
        if (plan.provider === "azure")
            return { provider: "azure", keySource };
        if (plan.provider === "google")
            return { provider: "gemini", keySource };
        return { provider: plan.provider, keySource };
    }
    const normalized = context.model?.toLowerCase() ?? "";
    const baseUrl = context.baseUrl?.toLowerCase() ?? "";
    if (baseUrl.includes("openrouter.ai") || (normalized.includes("/") && !baseUrl)) {
        return { provider: "openrouter", keySource: keyEnvForProvider("openrouter") };
    }
    if (context.azure?.endpoint?.trim() &&
        context.providerMode !== "openai" &&
        (normalized.startsWith("gpt") || normalized.startsWith("openai/") || !normalized.includes("/"))) {
        return { provider: "azure", keySource: keyEnvForProvider("azure") };
    }
    if (normalized.startsWith("anthropic/"))
        return providerRoute("anthropic");
    if (normalized.startsWith("google/"))
        return providerRoute("gemini");
    if (normalized.startsWith("xai/"))
        return providerRoute("xai");
    if (normalized.startsWith("openai/"))
        return providerRoute("openai");
    if (normalized.startsWith("claude"))
        return providerRoute("anthropic");
    if (normalized.startsWith("gemini"))
        return providerRoute("gemini");
    if (normalized.startsWith("grok"))
        return providerRoute("xai");
    return providerRoute("openai");
}
function providerRoute(provider) {
    return { provider, keySource: keyEnvForProvider(provider) };
}
function normalizeKeySource(keySource) {
    if (!keySource || keySource.includes("|")) {
        return undefined;
    }
    return keySource;
}
function keyEnvForProvider(provider) {
    switch (provider) {
        case "anthropic":
            return "ANTHROPIC_API_KEY";
        case "gemini":
            return "GEMINI_API_KEY";
        case "xai":
            return "XAI_API_KEY";
        case "azure":
            return "AZURE_OPENAI_API_KEY";
        case "openrouter":
            return "OPENROUTER_API_KEY";
        case "openai":
            return "OPENAI_API_KEY";
        default:
            return undefined;
    }
}
function doctorCommand(model) {
    return model ? `oracle doctor --providers --models ${model}` : "oracle doctor --providers";
}
function labelForCategory(category) {
    switch (category) {
        case "auth-failed":
            return "auth failed";
        case "auth-expired":
            return "auth expired";
        case "quota-exceeded":
            return "quota exceeded";
        case "rate-limited":
            return "rate limited";
        case "model-unavailable":
            return "model unavailable";
    }
}
function fixForCategory(category, provider, model, keySource) {
    const doctor = doctorCommand(model);
    const key = keySource ?? keyEnvForProvider(provider) ?? "the provider API key";
    switch (category) {
        case "auth-failed":
            return key === "apiKey option"
                ? `check --api-key value or run \`${doctor}\``
                : `refresh ${key} or run \`${doctor}\``;
        case "auth-expired":
            return key === "apiKey option"
                ? "replace --api-key value, then rerun the failed model"
                : `rotate ${key}, then rerun the failed model`;
        case "quota-exceeded":
            return `check ${provider} billing/quota, then rerun the failed model`;
        case "rate-limited":
            return "retry later or reduce parallel model fan-out";
        case "model-unavailable":
            return `check model access/ID with \`${doctor}\``;
    }
}
