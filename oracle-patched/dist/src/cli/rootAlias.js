import { attachSession, showStatus } from "./sessionDisplay.js";
const defaultDeps = {
    attachSession,
    showStatus,
};
export async function handleStatusFlag(options, deps = defaultDeps) {
    if (!options.status) {
        return false;
    }
    if (options.session) {
        await deps.attachSession(options.session);
        return true;
    }
    await deps.showStatus({ hours: 24, includeAll: false, limit: 100, showExamples: true });
    return true;
}
const defaultSessionDeps = {
    attachSession,
};
/**
 * Hidden root-level alias to attach to a stored session (`--session <id>`).
 * Returns true when the alias was handled so callers can short-circuit.
 */
export async function handleSessionAlias(options, deps = defaultSessionDeps) {
    if (!options.session) {
        return false;
    }
    await deps.attachSession(options.session);
    return true;
}
