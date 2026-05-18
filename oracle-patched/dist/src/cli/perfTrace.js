import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
const SECRET_VALUE_FLAGS = new Set([
    "--api-key",
    "--browser-follow-up",
    "--browser-inline-cookies",
    "--browser-inline-cookies-file",
    "--message",
    "--prompt",
    "--remote-token",
    "--token",
    "-p",
]);
const VALUE_FLAGS = new Set([
    "--aspect",
    "--azure-api-version",
    "--azure-deployment",
    "--azure-endpoint",
    "--base-url",
    "--browser-archive",
    "--browser-attachments",
    "--browser-auto-reattach-delay",
    "--browser-auto-reattach-interval",
    "--browser-auto-reattach-timeout",
    "--browser-bundle-format",
    "--browser-cookie-names",
    "--browser-cookie-path",
    "--browser-cookie-wait",
    "--browser-input-timeout",
    "--browser-max-concurrent-tabs",
    "--browser-model-strategy",
    "--browser-port",
    "--browser-profile-lock-timeout",
    "--browser-recheck-delay",
    "--browser-recheck-timeout",
    "--browser-research",
    "--browser-reuse-wait",
    "--browser-tab",
    "--browser-timeout",
    "--browser-url",
    "--chatgpt-url",
    "--engine",
    "--followup",
    "--followup-model",
    "--heartbeat",
    "--http-timeout",
    "--max-file-size-bytes",
    "--model",
    "--models",
    "--output",
    "--partial",
    "--perf-trace-path",
    "--provider",
    "--remote-chrome",
    "--remote-host",
    "--slug",
    "--timeout",
    "--write-output",
    "--youtube",
    "--zombie-timeout",
    "-e",
    "-m",
    "-s",
]);
export function isTraceValueFlag(flag) {
    return SECRET_VALUE_FLAGS.has(flag) || VALUE_FLAGS.has(flag);
}
class DisabledPerfTrace {
    mark() { }
    wrapFirstOutput() { }
    flush() { }
}
class FilePerfTrace {
    outputPath;
    options;
    events = [];
    wrapped = false;
    firstOutput = false;
    flushed = false;
    constructor(outputPath, options) {
        this.outputPath = outputPath;
        this.options = options;
    }
    mark(name, data) {
        this.events.push({
            name,
            ms: Number(performance.now().toFixed(3)),
            data,
        });
    }
    wrapFirstOutput() {
        if (this.wrapped)
            return;
        this.wrapped = true;
        const wrap = (stream) => {
            const original = stream.write.bind(stream);
            stream.write = ((...args) => {
                if (!this.firstOutput) {
                    this.firstOutput = true;
                    this.mark("first-output", {
                        stream: stream === process.stderr ? "stderr" : "stdout",
                    });
                }
                return original(...args);
            });
        };
        wrap(process.stdout);
        wrap(process.stderr);
    }
    flush(exitCode) {
        if (this.flushed)
            return;
        this.flushed = true;
        this.mark("exit", { exitCode: exitCode ?? 0 });
        const payload = {
            version: this.options.version,
            argv: sanitizeTraceArgv(this.options.argv),
            cwd: this.options.cwd ?? process.cwd(),
            pid: process.pid,
            node: process.version,
            timeOrigin: performance.timeOrigin,
            totalMs: Number(performance.now().toFixed(3)),
            events: this.events,
        };
        writeFileSync(this.outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
}
export function createPerfTrace(options) {
    const envValue = process.env.ORACLE_PERF_TRACE;
    const optionValue = options.value;
    if (!optionValue && !envValue) {
        return new DisabledPerfTrace();
    }
    const rawValue = typeof optionValue === "string" ? optionValue : envValue;
    const outputPath = rawValue && rawValue !== "1" && rawValue !== "true"
        ? path.resolve(options.cwd ?? process.cwd(), rawValue)
        : path.join(options.cwd ?? process.cwd(), `.oracle-perf-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
    const trace = new FilePerfTrace(outputPath, options);
    trace.wrapFirstOutput();
    trace.mark("cli-module-ready");
    return trace;
}
export function deriveDetachedPerfTraceEnv(value, sessionId) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "1" || trimmed.toLowerCase() === "true")
        return value;
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const lastDot = trimmed.lastIndexOf(".");
    if (lastDot > lastSlash) {
        return `${trimmed.slice(0, lastDot)}.${safeSessionId}${trimmed.slice(lastDot)}`;
    }
    return `${trimmed}.${safeSessionId}.json`;
}
export function resolveDetachedPerfTraceEnv(cliValue, envValue, sessionId) {
    if (typeof cliValue === "string") {
        return deriveDetachedPerfTraceEnv(cliValue, sessionId);
    }
    if (cliValue === true) {
        return "1";
    }
    return deriveDetachedPerfTraceEnv(envValue, sessionId);
}
export function buildDetachedPerfTraceEnv(env, cliValue, sessionId) {
    const nextEnv = { ...env };
    const traceValue = resolveDetachedPerfTraceEnv(cliValue, env.ORACLE_PERF_TRACE, sessionId);
    if (traceValue) {
        nextEnv.ORACLE_PERF_TRACE = traceValue;
    }
    else {
        delete nextEnv.ORACLE_PERF_TRACE;
    }
    return nextEnv;
}
export function sanitizeTraceArgv(argv) {
    const sanitized = [];
    let redactNext = false;
    let valueNext = false;
    let afterDoubleDash = false;
    for (const arg of argv) {
        if (afterDoubleDash) {
            sanitized.push("[redacted-positional]");
            continue;
        }
        if (arg === "--") {
            sanitized.push(arg);
            afterDoubleDash = true;
            continue;
        }
        if (redactNext) {
            sanitized.push("[redacted]");
            redactNext = false;
            continue;
        }
        if (valueNext) {
            sanitized.push(redactPotentialSecret(arg));
            valueNext = false;
            continue;
        }
        const equalsIndex = arg.indexOf("=");
        const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
        if (equalsIndex >= 0 && SECRET_VALUE_FLAGS.has(flag)) {
            sanitized.push(`${flag}=[redacted]`);
            continue;
        }
        if (arg.startsWith("-p") && arg.length > 2) {
            sanitized.push("-p[redacted]");
            continue;
        }
        if (equalsIndex >= 0) {
            sanitized.push(`${flag}=${redactPotentialSecret(arg.slice(equalsIndex + 1))}`);
            continue;
        }
        if (SECRET_VALUE_FLAGS.has(arg)) {
            sanitized.push(arg);
            redactNext = true;
            continue;
        }
        if (VALUE_FLAGS.has(arg)) {
            sanitized.push(arg);
            valueNext = true;
            continue;
        }
        if (!arg.startsWith("-")) {
            sanitized.push("[redacted-positional]");
            continue;
        }
        sanitized.push(arg);
    }
    return sanitized;
}
function redactPotentialSecret(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]")
        .replace(/:\/\/([^:/?#\s]+):([^@/?#\s]+)@/g, "://$1:[redacted]@")
        .replace(/([?&](?:access_)?token=)[^&#\s]+/gi, "$1[redacted]")
        .replace(/([?&](?:api[-_]?key|auth|authorization|password|secret)=)[^&#\s]+/gi, "$1[redacted]")
        .replace(/\bsk-(?:ant-|or-)?[A-Za-z0-9_-]{8,}\b/g, "sk-...[redacted]")
        .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, "xai-...[redacted]")
        .replace(/\bAIza[0-9A-Za-z_-]{8,}\b/g, "AIza...[redacted]");
}
