import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "./utils.js";
const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
    DEVTOOLS_ACTIVE_PORT_FILENAME,
    path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
];
const CHROME_PID_FILENAME = "chrome.pid";
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";
const execFileAsync = promisify(execFile);
export function getDevToolsActivePortPaths(userDataDir) {
    return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}
export async function readDevToolsPort(userDataDir) {
    for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
        try {
            const raw = await readFile(candidate, "utf8");
            const firstLine = raw.split(/\r?\n/u)[0]?.trim();
            const port = Number.parseInt(firstLine ?? "", 10);
            if (Number.isFinite(port)) {
                return port;
            }
        }
        catch {
            // ignore missing/unreadable candidates
        }
    }
    return null;
}
export async function writeDevToolsActivePort(userDataDir, port) {
    const contents = `${port}\n/devtools/browser`;
    for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
        try {
            await mkdir(path.dirname(candidate), { recursive: true });
            await writeFile(candidate, contents, "utf8");
        }
        catch {
            // best effort
        }
    }
}
export async function readChromePid(userDataDir) {
    const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
    try {
        const raw = (await readFile(pidPath, "utf8")).trim();
        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            return null;
        }
        return pid;
    }
    catch {
        return null;
    }
}
export async function writeChromePid(userDataDir, pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return;
    const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
    try {
        await mkdir(path.dirname(pidPath), { recursive: true });
        await writeFile(pidPath, `${Math.trunc(pid)}\n`, "utf8");
    }
    catch {
        // best effort
    }
}
export async function findRunningChromeDebugTargetForProfile(userDataDir) {
    if (process.platform === "win32") {
        try {
            const escapedDir = userDataDir.replace(/'/g, "''");
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile",
                "-Command",
                `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*--user-data-dir*' -and $_.CommandLine -like '*${escapedDir}*' -and $_.CommandLine -match '--remote-debugging-port(?:=|\\s+)(\\d+)' } | ForEach-Object { "$($_.ProcessId) $($Matches[1]) $($_.CommandLine)" }`,
            ], {
                maxBuffer: 10 * 1024 * 1024,
            });
            return findChromeDebugTargetForProfileFromWindowsProcessList(String(stdout ?? ""), userDataDir);
        }
        catch {
            return null;
        }
    }
    try {
        const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
            maxBuffer: 10 * 1024 * 1024,
        });
        return findChromeDebugTargetForProfileFromProcessList(String(stdout ?? ""), userDataDir);
    }
    catch {
        return null;
    }
}
function findChromeDebugTargetForProfileFromWindowsProcessList(processList, userDataDir) {
    for (const line of processList.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match)
            continue;
        const pid = Number.parseInt(match[1] ?? "", 10);
        const port = Number.parseInt(match[2] ?? "", 10);
        const command = match[3] ?? "";
        if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(port) || port <= 0)
            continue;
        if (!command.includes(userDataDir))
            continue;
        return { pid, port };
    }
    return null;
}
function findChromeDebugTargetForProfileFromProcessList(processList, userDataDir) {
    for (const line of processList.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match)
            continue;
        const pid = Number.parseInt(match[1] ?? "", 10);
        const command = match[2] ?? "";
        const lower = command.toLowerCase();
        if (!Number.isFinite(pid) || pid <= 0)
            continue;
        if (!lower.includes("chrome") && !lower.includes("chromium"))
            continue;
        if (!lower.includes("user-data-dir") || !command.includes(userDataDir))
            continue;
        const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
        const port = Number.parseInt(portMatch?.[1] ?? "", 10);
        if (!Number.isFinite(port) || port <= 0)
            continue;
        return { pid, port };
    }
    return null;
}
export function findChromeDebugTargetForProfileFromProcessListForTest(processList, userDataDir) {
    return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir);
}
export async function terminateRecordedChromeForProfile(userDataDir, logger) {
    const pid = await readChromePid(userDataDir);
    if (!pid || !isProcessAlive(pid)) {
        return false;
    }
    const command = await readProcessCommand(pid);
    if (!isChromeCommandForUserDataDir(command, userDataDir)) {
        logger?.(`Recorded Chrome pid ${pid} does not match ${userDataDir}; skipping termination`);
        return false;
    }
    try {
        process.kill(pid, "SIGTERM");
        logger?.(`Terminated shared manual-login Chrome pid ${pid}`);
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.(`Failed to terminate shared manual-login Chrome pid ${pid}: ${message}`);
        return false;
    }
}
function isChromeCommandForUserDataDir(command, userDataDir) {
    if (!command)
        return false;
    const lower = command.toLowerCase();
    return ((lower.includes("chrome") || lower.includes("chromium")) &&
        lower.includes("user-data-dir") &&
        command.includes(userDataDir));
}
export function isChromeCommandForUserDataDirForTest(command, userDataDir) {
    return isChromeCommandForUserDataDir(command, userDataDir);
}
export function isProcessAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means "exists but no permission"; treat as alive.
        if (error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EPERM") {
            return true;
        }
        return false;
    }
}
function parseProfileRunLock(payload) {
    if (!payload)
        return null;
    try {
        const parsed = JSON.parse(payload);
        if (!Number.isFinite(parsed.pid) || parsed.pid <= 0)
            return null;
        if (!parsed.lockId || typeof parsed.lockId !== "string")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export async function acquireProfileRunLock(userDataDir, options) {
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    const pollMs = typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
        ? options.pollMs
        : 1000;
    const lockPath = path.join(userDataDir, ORACLE_PROFILE_LOCK_FILENAME);
    const lockId = randomUUID();
    const startedAt = Date.now();
    let warned = false;
    for (;;) {
        try {
            const payload = {
                pid: process.pid,
                lockId,
                createdAt: new Date().toISOString(),
                sessionId: options.sessionId,
            };
            await mkdir(path.dirname(lockPath), { recursive: true });
            await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
            options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
            return {
                path: lockPath,
                lockId,
                release: async () => releaseProfileRunLock(lockPath, lockId, options.logger),
            };
        }
        catch (error) {
            const code = error.code;
            if (code !== "EEXIST") {
                throw error;
            }
            let existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
            if (!existing) {
                // Likely partial write / corruption; re-read once, then delete (user preference: delete unreadable lockfiles).
                await delay(200);
                existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
                if (!existing) {
                    options.logger?.("Oracle profile lock unreadable; deleting lockfile.");
                    await rm(lockPath, { force: true }).catch(() => undefined);
                    continue;
                }
            }
            if (!existing || !isProcessAlive(existing.pid)) {
                await rm(lockPath, { force: true }).catch(() => undefined);
                continue;
            }
            if (!warned) {
                const waited = Math.round(timeoutMs / 1000);
                options.logger?.(`Oracle profile lock held by pid ${existing.pid}; waiting up to ${waited}s.`);
                warned = true;
            }
            const elapsed = Date.now() - startedAt;
            if (elapsed >= timeoutMs) {
                throw new Error(`Oracle profile lock still held by pid ${existing.pid} after ${Math.round(elapsed / 1000)}s`);
            }
            await delay(Math.min(pollMs, timeoutMs - elapsed));
        }
    }
}
export async function releaseProfileRunLock(lockPath, lockId, logger) {
    try {
        const existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
        if (!existing || existing.lockId !== lockId) {
            return;
        }
        await rm(lockPath, { force: true });
        logger?.(`Released Oracle profile lock ${lockPath}`);
    }
    catch {
        // best effort
    }
}
export async function verifyDevToolsReachable({ port, host = "127.0.0.1", attempts = 3, timeoutMs = 3000, }) {
    const versionUrl = `http://${host}:${port}/json/version`;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(versionUrl, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return { ok: true };
        }
        catch (error) {
            if (attempt < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                continue;
            }
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: message };
        }
    }
    return { ok: false, error: "unreachable" };
}
export async function shouldCleanupManualLoginProfileState(userDataDir, logger, options = {}) {
    const port = await readDevToolsPort(userDataDir);
    if (!port) {
        return true;
    }
    const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
    if (probe.ok) {
        logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
        return false;
    }
    logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
    return true;
}
export async function cleanupStaleProfileState(userDataDir, logger, options = {}) {
    for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
        try {
            await rm(candidate, { force: true });
            logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
        }
        catch {
            // ignore cleanup errors
        }
    }
    const lockRemovalMode = options.lockRemovalMode ?? "never";
    if (lockRemovalMode === "never") {
        return;
    }
    const pid = await readChromePid(userDataDir);
    if (!pid) {
        return;
    }
    if (isProcessAlive(pid)) {
        logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
        return;
    }
    // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
    // without remote debugging), never delete lock files.
    if (await isChromeUsingUserDataDir(userDataDir)) {
        logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
        return;
    }
    const lockFiles = [
        path.join(userDataDir, "lockfile"),
        path.join(userDataDir, "SingletonLock"),
        path.join(userDataDir, "SingletonSocket"),
        path.join(userDataDir, "SingletonCookie"),
    ];
    for (const lock of lockFiles) {
        await rm(lock, { force: true }).catch(() => undefined);
    }
    logger?.("Cleaned up stale Chrome profile locks");
}
async function isChromeUsingUserDataDir(userDataDir) {
    if (process.platform === "win32") {
        // On Windows, lockfiles are typically held open and removal should fail anyway; avoid expensive process scans.
        return false;
    }
    try {
        const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
            maxBuffer: 10 * 1024 * 1024,
        });
        const lines = String(stdout ?? "").split("\n");
        const needle = userDataDir;
        for (const line of lines) {
            if (!line)
                continue;
            const lower = line.toLowerCase();
            if (!lower.includes("chrome") && !lower.includes("chromium"))
                continue;
            if (line.includes(needle) && lower.includes("user-data-dir")) {
                return true;
            }
        }
    }
    catch {
        // best effort
    }
    return false;
}
async function readProcessCommand(pid) {
    try {
        const { stdout } = await execFileAsync("ps", ["-p", String(Math.trunc(pid)), "-o", "command="], {
            maxBuffer: 1024 * 1024,
        });
        const command = String(stdout ?? "").trim();
        return command || null;
    }
    catch {
        return null;
    }
}
