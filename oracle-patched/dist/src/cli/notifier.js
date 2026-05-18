import notifier from "toasted-notifier";
import { spawn } from "node:child_process";
import { formatUSD, formatNumber } from "../oracle/format.js";
import { MODEL_CONFIGS } from "../oracle/config.js";
import { estimateUsdCost } from "tokentally";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const ORACLE_EMOJI = "🧿";
export function resolveNotificationSettings({ cliNotify, cliNotifySound, env, config, }) {
    const defaultEnabled = !(bool(env.CI) || bool(env.SSH_CONNECTION) || muteByConfig(env, config));
    const envNotify = parseToggle(env.ORACLE_NOTIFY);
    const envSound = parseToggle(env.ORACLE_NOTIFY_SOUND);
    const enabled = cliNotify ?? envNotify ?? config?.enabled ?? defaultEnabled;
    const sound = cliNotifySound ?? envSound ?? config?.sound ?? false;
    return { enabled, sound };
}
export function deriveNotificationSettingsFromMetadata(metadata, env, config) {
    if (metadata?.notifications) {
        return metadata.notifications;
    }
    return resolveNotificationSettings({
        cliNotify: undefined,
        cliNotifySound: undefined,
        env,
        config,
    });
}
export async function sendSessionNotification(payload, settings, log, answerPreview) {
    if (!settings.enabled || isTestEnv(process.env)) {
        return;
    }
    const title = `Oracle${ORACLE_EMOJI} finished`;
    const message = buildMessage(payload, sanitizePreview(answerPreview));
    try {
        if (await tryMacNativeNotifier(title, message, settings)) {
            return;
        }
        if (!(await shouldSkipToastedNotifier())) {
            // Fallback to toasted-notifier (cross-platform). macAppIconOption() is only honored on macOS.
            await notifier.notify({
                title,
                message,
                sound: settings.sound,
            });
            return;
        }
    }
    catch (error) {
        if (isMacExecError(error)) {
            const repaired = await repairMacNotifier(log);
            if (repaired) {
                try {
                    await notifier.notify({ title, message, sound: settings.sound, ...macAppIconOption() });
                    return;
                }
                catch (retryError) {
                    const reason = describeNotifierError(retryError);
                    log(`(notify skipped after retry: ${reason})`);
                    return;
                }
            }
        }
        if (isMacBadCpuError(error)) {
            const reason = describeNotifierError(error);
            log(`(notify skipped: ${reason})`);
            return;
        }
        const reason = describeNotifierError(error);
        log(`(notify skipped: ${reason})`);
    }
    // Last-resort macOS fallback: AppleScript alert (simple, noisy, but works when helpers are blocked).
    if (process.platform === "darwin") {
        try {
            await sendOsascriptAlert(title, message, log);
            return;
        }
        catch (scriptError) {
            const reason = describeNotifierError(scriptError);
            log(`(notify skipped: osascript fallback failed: ${reason})`);
        }
    }
}
function buildMessage(payload, answerPreview) {
    const parts = [];
    const sessionLabel = payload.sessionName || payload.sessionId;
    parts.push(sessionLabel);
    // Show cost only for API runs.
    if (payload.mode === "api") {
        const cost = payload.costUsd ?? inferCost(payload);
        if (cost !== undefined) {
            // Round to $0.00 for a concise toast.
            parts.push(formatUSD(Number(cost.toFixed(2))));
        }
    }
    if (payload.characters != null) {
        parts.push(`${formatNumber(payload.characters)} chars`);
    }
    if (answerPreview) {
        parts.push(answerPreview);
    }
    return parts.join(" · ");
}
function sanitizePreview(preview) {
    if (!preview)
        return undefined;
    let text = preview;
    // Strip code fences and inline code markers.
    text = text.replace(/```[\s\S]*?```/g, " ");
    text = text.replace(/`([^`]+)`/g, "$1");
    // Convert markdown links and images to their visible text.
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    // Drop bold/italic markers.
    text = text.replace(/(\*\*|__|\*|_)/g, "");
    // Remove headings / list markers / blockquotes.
    text = text.replace(/^\s*#+\s*/gm, "");
    text = text.replace(/^\s*[-*+]\s+/gm, "");
    text = text.replace(/^\s*>\s+/gm, "");
    // Collapse whitespace and trim.
    text = text.replace(/\s+/g, " ").trim();
    // Limit length to keep notifications short.
    const max = 200;
    if (text.length > max) {
        text = `${text.slice(0, max - 1)}…`;
    }
    return text;
}
// Exposed for unit tests only.
export const testHelpers = { sanitizePreview };
function inferCost(payload) {
    const model = payload.model;
    const usage = payload.usage;
    if (!model || !usage)
        return undefined;
    const config = MODEL_CONFIGS[model];
    if (!config?.pricing)
        return undefined;
    return (estimateUsdCost({
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        pricing: {
            inputUsdPerToken: config.pricing.inputPerToken,
            outputUsdPerToken: config.pricing.outputPerToken,
        },
    })?.totalUsd ?? undefined);
}
function parseToggle(value) {
    if (value == null)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
function bool(value) {
    return Boolean(value && String(value).length > 0);
}
function isMacExecError(error) {
    return Boolean(process.platform === "darwin" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EACCES");
}
function isMacBadCpuError(error) {
    return Boolean(process.platform === "darwin" &&
        error &&
        typeof error === "object" &&
        "errno" in error &&
        error.errno === -86);
}
async function repairMacNotifier(log) {
    const binPath = macNotifierPath();
    if (!binPath)
        return false;
    try {
        await fs.chmod(binPath, 0o755);
        return true;
    }
    catch (chmodError) {
        const reason = chmodError instanceof Error ? chmodError.message : String(chmodError);
        log(`(notify repair failed: ${reason} — try: xattr -dr com.apple.quarantine "${path.dirname(binPath)}")`);
        return false;
    }
}
function macNotifierPath() {
    if (process.platform !== "darwin")
        return null;
    try {
        const req = createRequire(import.meta.url);
        const modPath = req.resolve("toasted-notifier");
        const base = path.dirname(modPath);
        return path.join(base, "vendor", "mac.noindex", "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier");
    }
    catch {
        return null;
    }
}
async function shouldSkipToastedNotifier() {
    if (process.platform !== "darwin")
        return false;
    // On Apple Silicon without Rosetta, prefer the native helper and skip x86-only fallback.
    const arch = process.arch;
    if (arch !== "arm64")
        return false;
    return !(await hasRosetta());
}
async function hasRosetta() {
    return new Promise((resolve) => {
        const child = spawn("pkgutil", ["--files", "com.apple.pkg.RosettaUpdateAuto"], {
            stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
    });
}
async function sendOsascriptAlert(title, message, _log) {
    return new Promise((resolve, reject) => {
        const child = spawn("osascript", [
            "-e",
            `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
        ], {
            stdio: "ignore",
        });
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            }
            else {
                reject(new Error(`osascript exited with code ${code ?? -1}`));
            }
        });
        child.on("error", reject);
    });
}
function escapeAppleScript(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function macAppIconOption() {
    if (process.platform !== "darwin")
        return {};
    const iconPaths = [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets-oracle-icon.png"),
        path.resolve(process.cwd(), "assets-oracle-icon.png"),
    ];
    for (const candidate of iconPaths) {
        if (candidate && fsExistsSync(candidate)) {
            return { appIcon: candidate };
        }
    }
    return {};
}
function fsExistsSync(target) {
    try {
        return Boolean(require("node:fs").statSync(target));
    }
    catch {
        return false;
    }
}
async function tryMacNativeNotifier(title, message, settings) {
    const binary = macNativeNotifierPath();
    if (!binary)
        return false;
    return new Promise((resolve) => {
        const child = spawn(binary, [title, message, settings.sound ? "Glass" : ""], {
            stdio: "ignore",
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
    });
}
function macNativeNotifierPath() {
    if (process.platform !== "darwin")
        return null;
    const candidates = [
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/oracle-notifier/OracleNotifier.app/Contents/MacOS/OracleNotifier"),
        path.resolve(process.cwd(), "vendor/oracle-notifier/OracleNotifier.app/Contents/MacOS/OracleNotifier"),
    ];
    for (const candidate of candidates) {
        if (fsExistsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
function muteByConfig(env, config) {
    if (!config?.muteIn)
        return false;
    return ((config.muteIn.includes("CI") && bool(env.CI)) ||
        (config.muteIn.includes("SSH") && bool(env.SSH_CONNECTION)));
}
function isTestEnv(env) {
    return (env.ORACLE_DISABLE_NOTIFICATIONS === "1" ||
        env.NODE_ENV === "test" ||
        Boolean(env.VITEST || env.VITEST_WORKER_ID || env.JEST_WORKER_ID));
}
function describeNotifierError(error) {
    if (error && typeof error === "object") {
        const err = error;
        if (typeof err.errno === "number" || typeof err.code === "string") {
            const errno = typeof err.errno === "number" ? err.errno : undefined;
            // macOS returns errno -86 for “Bad CPU type in executable” (e.g., wrong arch or quarantined binary).
            if (errno === -86) {
                return "notifier binary failed to launch (Bad CPU type/quarantine); try xattr -dr com.apple.quarantine vendor/oracle-notifier && ./vendor/oracle-notifier/build-notifier.sh";
            }
        }
        if (typeof err.message === "string") {
            return err.message;
        }
    }
    return typeof error === "string" ? error : String(error);
}
