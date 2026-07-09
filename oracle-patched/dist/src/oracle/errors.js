import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { APIError } from "openai/error";
import { formatElapsed } from "./format.js";
export class OracleUserError extends Error {
    category;
    details;
    constructor(category, message, details, cause) {
        super(message);
        this.name = "OracleUserError";
        this.category = category;
        this.details = details;
        if (cause) {
            this.cause = cause;
        }
    }
}
export class FileValidationError extends OracleUserError {
    constructor(message, details, cause) {
        super("file-validation", message, details, cause);
        this.name = "FileValidationError";
    }
}
export class BrowserAutomationError extends OracleUserError {
    constructor(message, details, cause) {
        super("browser-automation", message, details, cause);
        this.name = "BrowserAutomationError";
    }
}
export class PromptValidationError extends OracleUserError {
    constructor(message, details, cause) {
        super("prompt-validation", message, details, cause);
        this.name = "PromptValidationError";
    }
}
export function asOracleUserError(error) {
    if (error instanceof OracleUserError) {
        return error;
    }
    return null;
}
export class OracleTransportError extends Error {
    reason;
    constructor(reason, message, cause) {
        super(message);
        this.name = "OracleTransportError";
        this.reason = reason;
        if (cause) {
            this.cause = cause;
        }
    }
}
export class OracleResponseError extends Error {
    metadata;
    response;
    constructor(message, response) {
        super(message);
        this.name = "OracleResponseError";
        this.response = response;
        this.metadata = extractResponseMetadata(response);
    }
}
export function extractResponseMetadata(response) {
    if (!response) {
        return {};
    }
    const metadata = {
        responseId: response.id,
        status: response.status,
        incompleteReason: response.incomplete_details?.reason ?? undefined,
    };
    const requestId = response._request_id;
    if (requestId !== undefined) {
        metadata.requestId = requestId;
    }
    return metadata;
}
export function toTransportError(error, model) {
    if (error instanceof OracleTransportError) {
        return error;
    }
    if (error instanceof APIConnectionTimeoutError) {
        return new OracleTransportError("client-timeout", "OpenAI request timed out before completion.", error);
    }
    if (error instanceof APIUserAbortError) {
        return new OracleTransportError("client-abort", "The request was aborted before OpenAI finished responding.", error);
    }
    if (error instanceof APIConnectionError) {
        return new OracleTransportError("connection-lost", "Connection to OpenAI dropped before the response completed.", error);
    }
    const isApiError = error instanceof APIError || error?.name === "APIError";
    if (isApiError) {
        const apiError = error;
        const code = apiError.code ?? apiError.error?.code;
        const messageText = apiError.message?.toLowerCase?.() ?? "";
        const apiMessage = apiError.error?.message ||
            apiError.message ||
            (apiError.status ? `${apiError.status} OpenAI API error` : "OpenAI API error");
        const modelUnavailable = code === "model_not_found" ||
            messageText.includes("does not exist") ||
            messageText.includes("unknown model") ||
            messageText.includes("model_not_found");
        if (model.startsWith("gpt-5.6") && modelUnavailable) {
            return new OracleTransportError("model-unavailable", `${model} is not available for this API organization. GPT-5.6 API preview access must be explicitly provisioned; confirm the approved organization or use gpt-5.5. Browser mode can use GPT-5.6 when the tier is visible in the signed-in ChatGPT account.`, apiError);
        }
        // Friendly guidance when a pro-tier model isn't available on this base URL / API key.
        if ((model === "gpt-5.5-pro" || model === "gpt-5.4-pro") &&
            modelUnavailable) {
            return new OracleTransportError("model-unavailable", `${model} is not available on this API base/key. Try gpt-5.5, gpt-5-pro, or switch to the browser engine.`, apiError);
        }
        if (apiError.status === 404 || apiError.status === 405) {
            return new OracleTransportError("unsupported-endpoint", "HTTP 404/405 from the Responses API; this base URL or gateway likely does not expose /v1/responses. Set OPENAI_BASE_URL to api.openai.com/v1, update your Azure API version/deployment, or use the browser engine.", apiError);
        }
        return new OracleTransportError("api-error", apiMessage, apiError);
    }
    return new OracleTransportError("unknown", error instanceof Error ? error.message : "Unknown transport failure.", error);
}
export function describeTransportError(error, deadlineMs) {
    switch (error.reason) {
        case "client-timeout":
            return deadlineMs
                ? `Client-side timeout: OpenAI streaming call exceeded the ${formatElapsed(deadlineMs)} deadline.`
                : "Client-side timeout: OpenAI streaming call exceeded the configured deadline.";
        case "connection-lost":
            return "Connection to OpenAI ended unexpectedly before the response completed.";
        case "client-abort":
            return "Request was aborted before OpenAI completed the response.";
        case "api-error":
            return error.message;
        case "model-unavailable":
            return error.message;
        case "unsupported-endpoint":
            return "The Responses API returned 404/405 — your base URL/gateway probably lacks /v1/responses (check OPENAI_BASE_URL or switch to api.openai.com / browser engine).";
        default:
            return "OpenAI streaming call ended with an unknown transport error.";
    }
}
