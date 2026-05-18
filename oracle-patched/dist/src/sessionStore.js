import { ensureSessionStorage, initializeSession, readSessionMetadata, updateSessionMetadata, createSessionLogWriter, readSessionLog, readModelLog, readSessionRequest, listSessionsMetadata, filterSessionsByRange, deleteSessionsOlderThan, updateModelRunMetadata, getSessionPaths, getSessionsDir, } from "./sessionManager.js";
class FileSessionStore {
    ensureStorage() {
        return ensureSessionStorage();
    }
    createSession(options, cwd, notifications, baseSlugOverride) {
        return initializeSession(options, cwd, notifications, baseSlugOverride);
    }
    readSession(sessionId) {
        return readSessionMetadata(sessionId);
    }
    updateSession(sessionId, updates) {
        return updateSessionMetadata(sessionId, updates);
    }
    createLogWriter(sessionId, model) {
        return createSessionLogWriter(sessionId, model);
    }
    updateModelRun(sessionId, model, updates) {
        return updateModelRunMetadata(sessionId, model, updates);
    }
    readLog(sessionId) {
        return readSessionLog(sessionId);
    }
    readModelLog(sessionId, model) {
        return readModelLog(sessionId, model);
    }
    readRequest(sessionId) {
        return readSessionRequest(sessionId);
    }
    listSessions() {
        return listSessionsMetadata();
    }
    filterSessions(metas, options) {
        return filterSessionsByRange(metas, options);
    }
    deleteOlderThan(options) {
        return deleteSessionsOlderThan(options);
    }
    getPaths(sessionId) {
        return getSessionPaths(sessionId);
    }
    sessionsDir() {
        return getSessionsDir();
    }
}
export const sessionStore = new FileSessionStore();
export { wait } from "./sessionManager.js";
export async function pruneOldSessions(hours, log) {
    if (typeof hours !== "number" || Number.isNaN(hours) || hours <= 0) {
        return;
    }
    const result = await sessionStore.deleteOlderThan({ hours });
    if (result.deleted > 0) {
        log?.(`Pruned ${result.deleted} stored sessions older than ${hours}h.`);
    }
}
