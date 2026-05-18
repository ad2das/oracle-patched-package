import OpenAI from "openai";
import path from "node:path";
import { createRequire } from "node:module";
import { createGeminiClient } from "./gemini.js";
import { createClaudeClient } from "./claude.js";
import { isOpenRouterBaseUrl } from "./modelResolver.js";
import { isCustomBaseUrl } from "./baseUrl.js";
export function buildAzureResponsesBaseUrl(endpoint) {
    return `${endpoint.replace(/\/+$/, "")}/openai/v1`;
}
export function createDefaultClientFactory() {
    const customFactory = loadCustomClientFactory();
    if (customFactory)
        return customFactory;
    return (key, options) => {
        const openRouter = isOpenRouterBaseUrl(options?.baseUrl);
        const customProxy = isCustomBaseUrl(options?.baseUrl);
        // When using any custom/proxy base URL (OpenRouter, LiteLLM, vLLM, Together, etc.),
        // route ALL models through the OpenAI chat/completions adapter instead of native SDKs
        // which would reject the proxy's API key.
        if (!openRouter && !customProxy) {
            if (options?.model?.startsWith("gemini")) {
                // Gemini client uses its own SDK; allow passing the already-resolved id for transparency/logging.
                return createGeminiClient(key, options.model, options.resolvedModelId);
            }
            if (options?.model?.startsWith("claude")) {
                return createClaudeClient(key, options.model, options.resolvedModelId, options.baseUrl);
            }
        }
        let instance;
        const defaultHeaders = openRouter
            ? buildOpenRouterHeaders()
            : undefined;
        const httpTimeoutMs = typeof options?.httpTimeoutMs === "number" &&
            Number.isFinite(options.httpTimeoutMs) &&
            options.httpTimeoutMs > 0
            ? options.httpTimeoutMs
            : 20 * 60 * 1000;
        if (options?.azure?.endpoint) {
            instance = new OpenAI({
                apiKey: key,
                timeout: httpTimeoutMs,
                baseURL: buildAzureResponsesBaseUrl(options.azure.endpoint),
            });
        }
        else {
            instance = new OpenAI({
                apiKey: key,
                timeout: httpTimeoutMs,
                baseURL: options?.baseUrl,
                defaultHeaders,
            });
        }
        if (openRouter || customProxy) {
            return buildOpenRouterCompletionClient(instance);
        }
        return {
            responses: {
                stream: (body) => instance.responses.stream(body),
                create: (body) => instance.responses.create(body),
                retrieve: (id) => instance.responses.retrieve(id),
            },
        };
    };
}
function buildOpenRouterHeaders() {
    const headers = {};
    const referer = process.env.OPENROUTER_REFERER ??
        process.env.OPENROUTER_HTTP_REFERER ??
        "https://github.com/steipete/oracle";
    const title = process.env.OPENROUTER_TITLE ?? "Oracle CLI";
    if (referer) {
        headers["HTTP-Referer"] = referer;
    }
    if (title) {
        headers["X-Title"] = title;
    }
    return headers;
}
function loadCustomClientFactory() {
    const override = process.env.ORACLE_CLIENT_FACTORY;
    if (!override) {
        return null;
    }
    if (override === "INLINE_TEST_FACTORY") {
        return () => ({
            responses: {
                create: async () => ({ id: "inline-test", status: "completed" }),
                stream: async () => ({
                    [Symbol.asyncIterator]: () => ({
                        async next() {
                            return { done: true, value: undefined };
                        },
                    }),
                    finalResponse: async () => ({ id: "inline-test", status: "completed" }),
                }),
                retrieve: async (id) => ({ id, status: "completed" }),
            },
        });
    }
    try {
        const require = createRequire(import.meta.url);
        const resolved = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
        const moduleExports = require(resolved);
        const factory = typeof moduleExports === "function"
            ? moduleExports
            : typeof moduleExports?.default === "function"
                ? moduleExports.default
                : typeof moduleExports?.createClientFactory === "function"
                    ? moduleExports.createClientFactory
                    : null;
        if (typeof factory === "function") {
            return factory;
        }
        console.warn(`Custom client factory at ${resolved} did not export a function.`);
    }
    catch (error) {
        console.warn(`Failed to load ORACLE_CLIENT_FACTORY module "${override}":`, error);
    }
    return null;
}
// Exposed for tests
export { loadCustomClientFactory as __loadCustomClientFactory };
function buildOpenRouterCompletionClient(instance) {
    const adaptRequest = (body) => {
        const messages = [];
        if (body.instructions) {
            messages.push({ role: "system", content: body.instructions });
        }
        for (const entry of body.input) {
            const textParts = entry.content
                .map((c) => (c.type === "input_text" ? c.text : ""))
                .filter((t) => t)
                .join("\n\n");
            messages.push({
                role: entry.role ?? "user",
                content: textParts,
            });
        }
        const base = {
            model: body.model,
            messages,
            max_tokens: body.max_output_tokens,
        };
        const streaming = { ...base, stream: true };
        const nonStreaming = { ...base, stream: false };
        return { streaming, nonStreaming };
    };
    const adaptResponse = (response) => {
        const text = response.choices?.[0]?.message?.content ?? "";
        const usage = {
            input_tokens: response.usage?.prompt_tokens ?? 0,
            output_tokens: response.usage?.completion_tokens ?? 0,
            total_tokens: response.usage?.total_tokens ?? 0,
        };
        return {
            id: response.id ?? `openrouter-${Date.now()}`,
            status: "completed",
            output_text: [text],
            output: [{ type: "text", text }],
            usage,
        };
    };
    const stream = async (body) => {
        const { streaming } = adaptRequest(body);
        let finalUsage;
        let finalId;
        let aggregated = "";
        async function* iterator() {
            const completion = await instance.chat.completions.create(streaming);
            for await (const chunk of completion) {
                finalId = chunk.id ?? finalId;
                const delta = chunk.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                    aggregated += delta;
                    yield { type: "chunk", delta };
                }
                if (chunk.usage) {
                    finalUsage = chunk.usage;
                }
            }
        }
        const gen = iterator();
        return {
            [Symbol.asyncIterator]() {
                return gen;
            },
            async finalResponse() {
                return adaptResponse({
                    id: finalId ?? `openrouter-${Date.now()}`,
                    choices: [{ message: { role: "assistant", content: aggregated } }],
                    usage: finalUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    created: Math.floor(Date.now() / 1000),
                    model: "",
                    object: "chat.completion",
                });
            },
        };
    };
    const create = async (body) => {
        const { nonStreaming } = adaptRequest(body);
        const response = (await instance.chat.completions.create(nonStreaming));
        return adaptResponse(response);
    };
    return {
        responses: {
            stream,
            create,
            retrieve: async () => {
                throw new Error("retrieve is not supported for OpenRouter chat/completions fallback.");
            },
        },
    };
}
