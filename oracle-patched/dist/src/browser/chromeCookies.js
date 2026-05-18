import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import chromeCookies from 'chrome-cookies-secure';
import { COOKIE_URLS } from './constants.js';
import { ensureCookiesDirForFallback } from './windowsCookies.js';
const COOKIE_READ_TIMEOUT_MS = readDuration('ORACLE_COOKIE_LOAD_TIMEOUT_MS', 5_000);
const KEYCHAIN_PROBE_TIMEOUT_MS = readDuration('ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS', 3_000);
const MAC_KEYCHAIN_LABELS = loadKeychainLabels();
export async function loadChromeCookies({ targetUrl, profile, explicitCookiePath, filterNames, }) {
    if (process.platform === 'win32') {
        throw new Error('Cookie sync is disabled on Windows; use --browser-manual-login (persistent profile) or inline cookies instead.');
    }
    const urlsToCheck = Array.from(new Set([stripQuery(targetUrl), ...COOKIE_URLS]));
    const merged = new Map();
    const cookieFile = await resolveCookieFilePath({ explicitPath: explicitCookiePath, profile });
    const cookiesPath = await materializeCookieFile(cookieFile); // returns the copied file (or source on non-Windows)
    const fallbackDir = await ensureCookiesDirForFallback(cookiesPath);
    if (process.env.ORACLE_DEBUG_COOKIES === '1') {
        // eslint-disable-next-line no-console
        console.log(`[cookies] resolved cookie file: ${cookiesPath}`);
        console.log(`[cookies] fallback dir for chrome-cookies-secure: ${fallbackDir}`);
    }
    await ensureMacKeychainReadable();
    for (const url of urlsToCheck) {
        let raw;
        try {
            const pathForSecure = await adaptPathForChromeCookies(fallbackDir);
            raw = await settleWithTimeout(chromeCookies.getCookiesPromised(url, 'puppeteer', pathForSecure), COOKIE_READ_TIMEOUT_MS, `Timed out reading Chrome cookies from ${pathForSecure} (after ${COOKIE_READ_TIMEOUT_MS} ms)`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to load Chrome cookies for ${url}: ${message}`);
        }
        if (!Array.isArray(raw))
            continue;
        const fallbackHost = new URL(url).hostname;
        for (const cookie of raw) {
            if (filterNames && filterNames.size > 0 && !filterNames.has(cookie.name))
                continue;
            const normalized = normalizeCookie(cookie, fallbackHost);
            if (!normalized)
                continue;
            const key = `${normalized.domain ?? fallbackHost}:${normalized.name}`;
            if (!merged.has(key)) {
                merged.set(key, normalized);
            }
        }
    }
    return Array.from(merged.values());
}
async function ensureMacKeychainReadable() {
    if (process.platform === 'win32') {
        return;
    }
    // chrome-cookies-secure can hang forever when the platform keyring rejects access (e.g., SSH/no GUI).
    // Probe the keyring ourselves with a timeout so callers fail fast instead of blocking the run.
    let keytar = null;
    let keytarPath = null;
    try {
        const require = createRequire(import.meta.url);
        keytarPath = require.resolve('keytar');
        const keytarModule = await import('keytar');
        keytar = (keytarModule.default ?? keytarModule);
    }
    catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        const rebuildHint = keytarPath
            ? ` You may need to rebuild keytar: PYTHON=/usr/bin/python3 /Users/steipete/Projects/oracle/runner npx node-gyp rebuild (run inside ${path.dirname(keytarPath)}).`
            : '';
        throw new Error(`Failed to load keytar for secure cookie copy (${base}). Install keyring deps (macOS Keychain / libsecret) or rerun with --render --copy to paste into ChatGPT manually.${rebuildHint}`);
    }
    const password = await settleWithTimeout(findKeychainPassword(keytar, MAC_KEYCHAIN_LABELS), KEYCHAIN_PROBE_TIMEOUT_MS, `Timed out reading macOS Keychain while looking up Chrome Safe Storage (after ${KEYCHAIN_PROBE_TIMEOUT_MS} ms). Unlock the login keychain or start oracle serve from a GUI session.`);
    if (!password) {
        throw new Error('macOS Keychain denied access to Chrome cookies. Unlock the login keychain or run oracle serve from a GUI session, then retry.');
    }
}
async function findKeychainPassword(keytar, labels) {
    let lastError = null;
    for (const label of labels) {
        try {
            const value = await keytar.getPassword(label.service, label.account);
            if (value)
                return value;
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    if (lastError) {
        throw lastError;
    }
    return null;
}
function settleWithTimeout(promise, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function normalizeCookie(cookie, fallbackHost) {
    if (!cookie?.name)
        return null;
    const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain ?? fallbackHost;
    const expires = normalizeExpiration(cookie.expires);
    const secure = typeof cookie.Secure === 'boolean' ? cookie.Secure : true;
    const httpOnly = typeof cookie.HttpOnly === 'boolean' ? cookie.HttpOnly : false;
    return {
        name: cookie.name,
        value: cleanValue(cookie.value ?? ''),
        domain,
        path: cookie.path ?? '/',
        expires,
        secure,
        httpOnly,
    };
}
function cleanValue(value) {
    let i = 0;
    while (i < value.length && value.charCodeAt(i) < 0x20)
        i += 1;
    return value.slice(i);
}
function normalizeExpiration(expires) {
    if (!expires || Number.isNaN(expires)) {
        return undefined;
    }
    const value = Number(expires);
    if (value <= 0)
        return undefined;
    if (value > 1_000_000_000_000) {
        return Math.round(value / 1_000_000 - 11644473600);
    }
    if (value > 1_000_000_000) {
        return Math.round(value / 1000);
    }
    return Math.round(value);
}
async function resolveCookieFilePath({ explicitPath, profile, }) {
    if (explicitPath && explicitPath.trim().length > 0) {
        return ensureCookieFile(explicitPath);
    }
    if (profile && looksLikePath(profile)) {
        return ensureCookieFile(profile);
    }
    const profileName = profile && profile.trim().length > 0 ? profile : 'Default';
    const baseDir = await defaultProfileRoot();
    return ensureCookieFile(path.join(baseDir, profileName));
}
async function adaptPathForChromeCookies(resolved) {
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isFile()) {
        // chrome-cookies-secure appends "Cookies" when given a directory; if we already have the file, return its directory.
        return path.dirname(resolved);
    }
    return resolved;
}
async function ensureCookieFile(inputPath) {
    const expanded = expandPath(inputPath);
    const stat = await fs.stat(expanded).catch(() => null);
    if (!stat) {
        throw new Error(`Unable to locate Chrome cookie DB at ${expanded}`);
    }
    if (stat.isDirectory()) {
        const directFile = path.join(expanded, 'Cookies');
        if (await fileExists(directFile))
            return directFile;
        const networkFile = path.join(expanded, 'Network', 'Cookies');
        if (await fileExists(networkFile))
            return networkFile;
        throw new Error(`No Cookies DB found under ${expanded}`);
    }
    return expanded;
}
async function fileExists(candidate) {
    try {
        const stat = await fs.stat(candidate);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
function expandPath(input) {
    if (input.startsWith('~/')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}
function looksLikePath(value) {
    return value.includes('/') || value.includes('\\');
}
async function materializeCookieFile(sourcePath) {
    if (process.platform !== 'win32')
        return sourcePath;
    // Chrome can keep the Cookies DB locked; copy to a temp file so sqlite can open it reliably.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookies-'));
    const tempPath = path.join(tempDir, 'Cookies');
    try {
        await fs.copyFile(sourcePath, tempPath);
        return tempPath;
    }
    catch (_error) {
        // Fall back to the original path if the copy fails; upstream error handling will surface issues.
        return sourcePath;
    }
}
async function defaultProfileRoot() {
    const candidates = [];
    if (process.platform === 'darwin') {
        candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'), path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'), path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'));
    }
    else if (process.platform === 'linux') {
        if (isWsl()) {
            const windowsHomes = [process.env.USERPROFILE, process.env.WIN_HOME, process.env.HOME?.replace('/home', '/mnt/c/Users')]
                .filter((p) => Boolean(p))
                .map((p) => p.replace(/\\/g, '/'));
            const wslCandidates = [];
            for (const home of windowsHomes) {
                const normalized = home.startsWith('/mnt/') ? home : `/mnt/c/Users/${path.basename(home)}`;
                wslCandidates.push(path.join(normalized, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), path.join(normalized, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'));
            }
            // Ensure we don't pick a non-user Default profile ahead of real ones.
            for (const candidate of wslCandidates) {
                const hasProfile = existsSync(path.join(candidate, 'Default'));
                if (hasProfile) {
                    candidates.push(candidate);
                }
            }
        }
        candidates.push(path.join(os.homedir(), '.config', 'google-chrome'), path.join(os.homedir(), '.config', 'microsoft-edge'), path.join(os.homedir(), '.config', 'chromium'), 
        // Snap Chromium profiles
        path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium'), path.join(os.homedir(), 'snap', 'chromium', 'current', 'chromium'));
    }
    else if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        candidates.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'), path.join(localAppData, 'Microsoft', 'Edge', 'User Data'), path.join(localAppData, 'Chromium', 'User Data'));
    }
    else {
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    // fallback: first candidate even if missing; upstream will throw clearer error
    return candidates[0];
}
function stripQuery(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString();
    }
    catch {
        return url;
    }
}
function readDuration(envKey, fallback) {
    const raw = process.env[envKey];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function isWsl() {
    if (process.platform !== 'linux')
        return false;
    return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes('microsoft'));
}
function loadKeychainLabels() {
    const defaults = [
        { service: 'Chrome Safe Storage', account: 'Chrome' },
        { service: 'Chromium Safe Storage', account: 'Chromium' },
        { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
        { service: 'Brave Safe Storage', account: 'Brave' },
        { service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
    ];
    const rawEnv = process.env.ORACLE_KEYCHAIN_LABELS;
    if (!rawEnv)
        return defaults;
    try {
        const parsed = JSON.parse(rawEnv);
        if (!Array.isArray(parsed))
            return defaults;
        const envLabels = parsed
            .map((entry) => (entry && typeof entry === 'object' ? entry : null))
            .filter((entry) => Boolean(entry?.service && entry?.account));
        return envLabels.length ? [...envLabels, ...defaults] : defaults;
    }
    catch {
        return defaults;
    }
}
// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
    normalizeExpiration,
    cleanValue,
    looksLikePath,
    defaultProfileRoot,
};
