import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
let cachedUnprotect = null;
function getUnprotectData() {
    if (cachedUnprotect) {
        return cachedUnprotect;
    }
    try {
        // win-dpapi is CommonJS; require it explicitly and support both named/default shapes.
        const dpapiModule = createRequire(import.meta.url)('win-dpapi');
        const unprotect = dpapiModule?.Dpapi?.unprotectData ??
            dpapiModule?.default?.unprotectData ??
            ((_) => {
                throw new Error('win-dpapi unprotectData not available');
            });
        cachedUnprotect = unprotect;
        return unprotect;
    }
    catch (error) {
        if (process.platform !== 'win32') {
            // On macOS/Linux we don't need DPAPI; return a function that makes misuse obvious.
            cachedUnprotect = () => {
                throw new Error('win-dpapi is unavailable on non-Windows platforms');
            };
            return cachedUnprotect;
        }
        throw error;
    }
}
export async function loadWindowsCookies(dbPath, filterNames) {
    if (process.platform !== 'win32') {
        throw new Error('loadWindowsCookies is only supported on Windows');
    }
    const localStatePath = await locateLocalState(dbPath);
    const cookiesCopy = await copyLockedFile(dbPath, 'Cookies'); // name the copy exactly "Cookies"
    const cookiesDirForFallback = await ensureCookiesDirForFallback(cookiesCopy);
    const localStateCopy = await copyLockedFile(localStatePath, 'Local State');
    const aesKey = await extractWindowsAesKey(localStateCopy);
    const rows = await readChromeCookiesDb(cookiesCopy, filterNames);
    const cookies = [];
    for (const row of rows) {
        const enc = row.encrypted_value && row.encrypted_value.length > 0 ? row.encrypted_value : Buffer.from(row.value ?? '', 'utf8');
        const decrypted = enc.length > 0 ? decryptCookie(enc, aesKey) : '';
        cookies.push({
            name: row.name,
            value: decrypted,
            domain: row.host_key?.startsWith('.') ? row.host_key.slice(1) : row.host_key,
            path: row.path ?? '/',
            expires: normalizeExpiration(row.expires_utc),
            secure: Boolean(row.is_secure),
            httpOnly: Boolean(row.is_httponly),
        });
    }
    if (process.env.ORACLE_DEBUG_COOKIES === '1') {
        // eslint-disable-next-line no-console
        console.log(`[cookies] windows decrypt decoded ${cookies.length} cookies from ${cookiesCopy} (fallback dir ${cookiesDirForFallback})`);
    }
    return cookies.filter((c) => c.value);
}
function decryptCookie(value, aesKey) {
    const prefix = value.slice(0, 3).toString();
    // Chrome prefixes AES-GCM encrypted cookies with version markers like v10/v11/v20; treat all v** the same.
    if (/^v\d{2}$/u.test(prefix)) {
        const iv = value.slice(3, 15);
        const tag = value.slice(value.length - 16);
        const data = value.slice(15, value.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
        return decrypted.toString('utf8');
    }
    const unprotectData = getUnprotectData();
    const unprotected = unprotectData(value, undefined, 'CurrentUser');
    return Buffer.from(unprotected).toString('utf8');
}
async function locateLocalState(dbPath) {
    // Prefer sibling Local State near the profile path; fall back to default location.
    const guess = path.resolve(path.join(path.dirname(dbPath), '..', 'Local State'));
    if (existsSync(guess))
        return guess;
    const localState = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
    if (existsSync(localState))
        return localState;
    throw new Error('Chrome Local State not found for AES key');
}
async function extractWindowsAesKey(localStatePath) {
    const raw = await fs.readFile(localStatePath, 'utf8');
    const state = JSON.parse(raw);
    const encKeyB64 = state?.os_crypt?.encrypted_key;
    if (!encKeyB64)
        throw new Error('encrypted_key missing in Local State');
    const encKey = Buffer.from(encKeyB64, 'base64');
    const dpapiBlob = encKey.slice(5); // strip "DPAPI"
    const unprotectData = getUnprotectData();
    const unprotected = unprotectData(dpapiBlob, undefined, 'CurrentUser');
    return Buffer.from(unprotected);
}
async function readChromeCookiesDb(dbPath, filterNames) {
    const db = await openSqlite(dbPath);
    const placeholders = filterNames && filterNames.size > 0 ? `AND name IN (${Array.from(filterNames).map(() => '?').join(',')})` : '';
    const params = filterNames ? Array.from(filterNames) : [];
    const sql = `SELECT name,value,encrypted_value,host_key,path,expires_utc,is_secure,is_httponly FROM cookies WHERE host_key LIKE '%chatgpt.com%' ${placeholders}`;
    try {
        return await allSqlite(db, sql, params);
    }
    finally {
        db.close();
    }
}
function openSqlite(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err)
                reject(err);
            else
                resolve(db);
        });
    });
}
async function copyLockedFile(sourcePath, targetName) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookie-'));
    const tempPath = targetName ? path.join(tempDir, targetName) : path.join(tempDir, path.basename(sourcePath));
    const psScript = `
$src = '${sourcePath.replace(/'/g, "''")}'
$dst = '${tempPath.replace(/'/g, "''")}'
try {
  $fs = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $bytes = New-Object byte[] $fs.Length
  $null = $fs.Read($bytes, 0, $fs.Length)
  $fs.Close()
  [System.IO.File]::WriteAllBytes($dst, $bytes)
  exit 0
} catch {
  exit 1
}
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 15000,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        // Fallback: best-effort normal copy
        await fs.copyFile(sourcePath, tempPath);
    }
    if (process.env.ORACLE_DEBUG_COOKIES === '1') {
        // eslint-disable-next-line no-console
        console.log(`[cookies] copied locked file ${sourcePath} -> ${tempPath}`);
    }
    return tempPath;
}
// Create a directory containing a file named "Cookies" for chrome-cookies-secure fallback
export async function ensureCookiesDirForFallback(cookieFile) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookies-secure-'));
    const target = path.join(dir, 'Cookies');
    await fs.copyFile(cookieFile, target);
    return dir;
}
function allSqlite(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err)
                reject(err);
            else
                resolve((rows ?? []));
        });
    });
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
export async function materializeCookieFile(sourcePath) {
    if (process.platform !== 'win32')
        return sourcePath;
    const resolved = await resolveDirectoryCandidate(sourcePath);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookies-'));
    const tempPath = path.join(tempDir, 'Cookies');
    await fs.copyFile(resolved, tempPath);
    return tempPath;
}
async function resolveDirectoryCandidate(inputPath) {
    const stat = await fs.stat(inputPath).catch(() => null);
    if (!stat?.isDirectory())
        return inputPath;
    const network = path.join(inputPath, 'Network', 'Cookies');
    const direct = path.join(inputPath, 'Cookies');
    if (await fileExists(network))
        return network;
    if (await fileExists(direct))
        return direct;
    return inputPath;
}
async function fileExists(candidate) {
    try {
        const stat = await fsp.stat(candidate);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
