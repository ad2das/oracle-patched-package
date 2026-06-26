import { discoverDevToolsActivePortCandidates, } from "./detect.js";
export async function resolveAttachRunningConnection(config, logger) {
    const host = config.remoteChrome?.host ?? "127.0.0.1";
    const port = config.remoteChrome?.port ?? 9222;
    if (config.chromePath) {
        logger("Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.");
    }
    logger(config.remoteChrome
        ? `Using explicit attach-running target ${host}:${port}.`
        : `Using default attach-running target ${host}:${port}.`);
    const candidates = (await discoverDevToolsActivePortCandidates({ host }))
        .filter((candidate) => candidate.port === port)
        .sort(compareDevToolsCandidates);
    if (candidates.length === 0) {
        const direct = await resolveDirectDevToolsConnection(host, port, logger);
        if (direct) {
            return direct;
        }
        throw new Error(`No running browser with attach metadata matched ${host}:${port}, and ${host}:${port}/json/version was not reachable. Enable remote debugging in chrome://inspect/#remote-debugging first.`);
    }
    const candidate = candidates[0];
    logger(`Selected attach-running browser metadata from ${candidate.path}`);
    return {
        host,
        port: candidate.port,
        browserWSEndpoint: candidate.browserWSEndpoint,
        profileRoot: candidate.profileRoot,
    };
}
async function resolveDirectDevToolsConnection(host, port, logger) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetch(`http://${host}:${port}/json/version`, {
            signal: controller.signal,
        });
        if (!response.ok) {
            logger(`Attach-running direct DevTools probe returned HTTP ${response.status} for ${host}:${port}.`);
            return null;
        }
        const version = await response.json();
        const browserWSEndpoint = typeof version?.webSocketDebuggerUrl === "string"
            ? version.webSocketDebuggerUrl
            : undefined;
        logger(browserWSEndpoint
            ? `Attach-running using live DevTools endpoint from ${host}:${port}/json/version.`
            : `Attach-running using live DevTools HTTP endpoint at ${host}:${port}.`);
        return {
            host,
            port,
            browserWSEndpoint,
            profileRoot: undefined,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Attach-running direct DevTools probe failed for ${host}:${port}: ${message}`);
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
function compareDevToolsCandidates(left, right) {
    if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
    }
    return left.path.localeCompare(right.path);
}
