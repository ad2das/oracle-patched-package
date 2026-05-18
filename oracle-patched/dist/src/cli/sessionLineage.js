function readResponseId(record) {
    if (!record)
        return null;
    const candidate = typeof record.responseId === "string"
        ? record.responseId
        : typeof record.id === "string"
            ? record.id
            : null;
    if (!candidate || !candidate.startsWith("resp_")) {
        return null;
    }
    return candidate;
}
export function collectSessionResponseIds(meta) {
    const ids = new Set();
    const rootResponse = readResponseId(meta.response);
    if (rootResponse) {
        ids.add(rootResponse);
    }
    const runs = Array.isArray(meta.models) ? meta.models : [];
    for (const run of runs) {
        const runResponse = readResponseId(run.response);
        if (runResponse) {
            ids.add(runResponse);
        }
    }
    return [...ids];
}
export function buildResponseOwnerIndex(sessions) {
    const byResponse = new Map();
    for (const session of sessions) {
        for (const responseId of collectSessionResponseIds(session)) {
            if (!byResponse.has(responseId)) {
                byResponse.set(responseId, session.id);
            }
        }
    }
    return byResponse;
}
export function resolveSessionLineage(meta, responseOwners) {
    const previous = meta.options?.previousResponseId?.trim();
    if (!previous) {
        return null;
    }
    let parentSessionId = meta.options?.followupSessionId?.trim();
    if (!parentSessionId && responseOwners) {
        parentSessionId = responseOwners.get(previous);
    }
    if (parentSessionId === meta.id) {
        parentSessionId = undefined;
    }
    return { parentResponseId: previous, parentSessionId };
}
export function abbreviateResponseId(responseId, max = 18) {
    if (responseId.length <= max) {
        return responseId;
    }
    const head = Math.max(8, max - 7);
    return `${responseId.slice(0, head)}...${responseId.slice(-4)}`;
}
