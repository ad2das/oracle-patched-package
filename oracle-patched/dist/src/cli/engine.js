import { isProModel } from "../oracle/modelResolver.js";
export function defaultWaitPreference(model, engine) {
    // Pro-class API runs can take a long time; prefer non-blocking unless explicitly overridden.
    if (engine === "api" && isProModel(model)) {
        return false;
    }
    return true; // browser or non-pro models are fast enough to block by default
}
/**
 * Determine which engine to use based on CLI flags and the environment.
 *
 * Precedence:
 * 1) Legacy --browser flag forces browser.
 * 2) Explicit --engine value.
 * 3) Explicit API provider routing flags force API.
 * 4) ORACLE_ENGINE environment override (api|browser).
 * 5) API environment decides: api when set, otherwise browser.
 */
export function resolveEngine({ engine, browserFlag, apiProviderRequested, env, }) {
    if (browserFlag) {
        return "browser";
    }
    if (engine) {
        return engine;
    }
    if (apiProviderRequested) {
        return "api";
    }
    const envEngine = normalizeEngineMode(env.ORACLE_ENGINE);
    if (envEngine) {
        return envEngine;
    }
    return hasApiEnvironment(env) ? "api" : "browser";
}
function hasApiEnvironment(env) {
    return Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
}
function normalizeEngineMode(raw) {
    if (typeof raw !== "string") {
        return null;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "api")
        return "api";
    if (normalized === "browser")
        return "browser";
    return null;
}
