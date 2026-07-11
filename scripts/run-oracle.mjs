#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  matchNewBrowserSession,
  promptForArgs,
  sessionPrompt,
} from "./run-oracle-session-match.mjs";
import { recoverLocalCompletedTranscript } from "./run-oracle-local-transcript.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const oracleDir = join(repoRoot, "oracle-patched");
const oracleCli = join(oracleDir, "dist", "bin", "oracle-cli.js");
const dependencyProbe = join(oracleDir, "node_modules", "dotenv", "package.json");

if (!existsSync(oracleCli)) {
  console.error(`Patched Oracle CLI not found: ${oracleCli}`);
  process.exit(1);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasArg(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function withoutArgs(args, names) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const matched = names.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (matched) {
      if (arg === matched) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function isBrowserRun(args) {
  const first = args.find((arg) => !arg.startsWith("-"));
  if (first === "session" || first === "status" || first === "serve" || first === "docs") return false;
  return argValue(args, "--engine") === "browser" || argValue(args, "-e") === "browser";
}

function isSessionRender(args) {
  const first = args.find((arg) => !arg.startsWith("-"));
  return first === "session" && args.includes("--render");
}

function sessionIdForSessionCommand(args) {
  if (!isSessionRender(args)) return null;
  const sessionIndex = args.indexOf("session");
  if (sessionIndex < 0) return null;
  return args.slice(sessionIndex + 1).find((arg) => !arg.startsWith("-")) ?? null;
}

function shouldDefaultKeepBrowser(args) {
  if (!isBrowserRun(args)) return false;
  if (process.env.ORACLE_BROWSER_ALLOW_CLOSE === "1") return false;
  if (args.includes("--browser-keep-browser")) return false;
  if (args.includes("--browser-attach-running")) return false;
  return true;
}

function withDefaultKeepBrowser(args) {
  return shouldDefaultKeepBrowser(args) ? [...args, "--browser-keep-browser"] : args;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function recentEnough(value, maxAgeMs) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function isTerminalSession(meta) {
  return meta?.status === "completed" || meta?.status === "error" || meta?.status === "cancelled";
}

function hasRecoverableGeneratingConversation(state, meta) {
  return Boolean(
    state?.generating &&
    meta?.status === "error" &&
    state?.url &&
    /chatgpt\.com\/c\//i.test(state.url)
  );
}

function readSessionMeta(oracleHome, sessionId) {
  if (!sessionId) return null;
  return readJson(join(oracleHome, "sessions", sessionId, "meta.json"));
}

function listSessionDirs(oracleHome) {
  const sessionsDir = join(oracleHome, "sessions");
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .map((sessionId) => {
      const sessionDir = join(sessionsDir, sessionId);
      try {
        const stat = statSync(sessionDir);
        return stat.isDirectory() ? { sessionId, sessionDir, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function browserSessions(oracleHome) {
  return listSessionDirs(oracleHome)
    .map((item) => {
      const meta = readSessionMeta(oracleHome, item.sessionId);
      return meta?.mode === "browser" || meta?.engine === "browser" ? { ...item, meta } : null;
    })
    .filter(Boolean);
}

function browserSessionIds(oracleHome) {
  return new Set(browserSessions(oracleHome).map((item) => item.sessionId));
}

function browserSessionForRun(oracleHome, args, baselineSessionIds) {
  return matchNewBrowserSession(browserSessions(oracleHome), args, baselineSessionIds);
}

function hasSubmittedRuntime(runtime) {
  // A reused --browser-tab already has a conversationId/tabUrl before this run types
  // anything. Only the explicit per-run commit flag is submission evidence.
  return runtime?.promptSubmitted === true;
}

function sessionLogText(sessionDir) {
  const chunks = [];
  for (const filePath of [
    join(sessionDir, "output.log"),
    join(sessionDir, "models", "gpt-5.5-pro.log"),
    join(sessionDir, "models", "gpt-5.2-instant.log"),
  ]) {
    try {
      chunks.push(readFileSync(filePath, "utf8").slice(-24000));
    } catch {
      // Missing model logs are normal.
    }
  }
  return chunks.join("\n");
}

function hasSubmittedLogEvidence(sessionDir) {
  const logText = sessionLogText(sessionDir);
  return /ChatGPT thinking|status=active|Stop generating|Finalizing answer|generating=true|Waiting for ChatGPT response/i.test(logText);
}

function submittedLogObservedAt(sessionDir, maxAgeMs = Number.POSITIVE_INFINITY) {
  let latest = 0;
  for (const filePath of [
    join(sessionDir, "output.log"),
    join(sessionDir, "models", "gpt-5.5-pro.log"),
    join(sessionDir, "models", "gpt-5.2-instant.log"),
  ]) {
    try {
      const stat = statSync(filePath);
      if (Date.now() - stat.mtimeMs > maxAgeMs) continue;
      const tail = readFileSync(filePath, "utf8").slice(-12000);
      if (/ChatGPT thinking|status=active|Stop generating|Finalizing answer|generating=true|Waiting for ChatGPT response/i.test(tail)) {
        latest = Math.max(latest, stat.mtimeMs);
      }
    } catch {
      // Missing logs are normal.
    }
  }
  return latest ? new Date(latest).toISOString() : null;
}

function readLiveSessionJson(sessionId) {
  const result = spawnSync(process.execPath, [
    join(scriptDir, "read-live-chatgpt.mjs"),
    "--session",
    sessionId,
    "--tail",
    "12000",
    "--json",
    "--no-open-missing",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function verifyBrowserSubmissionAfterFailure(args, baselineSessionIds) {
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const latest = browserSessionForRun(oracleHome, args, baselineSessionIds);
  if (!latest) {
    return {
      state: "unknown",
      reason: "no newly-created browser session matched the exact prompt fingerprint; preflight may have failed before session creation",
    };
  }

  const runtime = latest.meta?.browser?.runtime;
  const liveState = readJson(join(latest.sessionDir, "live-state.json"));
  if (latest.meta?.status === "completed") {
    return {
      state: "completed",
      session: latest.sessionId,
      reason: "matched browser session is already completed; render/recover its answer",
      usage: latest.meta?.usage,
    };
  }
  if (hasSubmittedRuntime(runtime)) {
    return {
      state: "submitted",
      session: latest.sessionId,
      reason: "session runtime recorded promptSubmitted/conversation evidence",
      url: runtime?.tabUrl,
      promptSubmitted: runtime?.promptSubmitted,
    };
  }
  if (hasSubmittedLogEvidence(latest.sessionDir)) {
    return {
      state: "submitted",
      session: latest.sessionId,
      reason: "session log recorded ChatGPT response/generation activity",
      url: runtime?.tabUrl,
      promptSubmitted: runtime?.promptSubmitted,
    };
  }
  const liveRead = readLiveSessionJson(latest.sessionId);
  if (liveRead.ok) {
    const output = liveRead.value;
    const url = output?.url || output?.tabUrl;
    const textLength = Number(output?.length ?? 0) || 0;
    if (isChatGptConversationUrl(url) && output?.promptMatch === true && (output?.generating || textLength > 0)) {
      return {
        state: "submitted",
        session: latest.sessionId,
        reason: "live DOM read found ChatGPT conversation content",
        url,
        generating: output?.generating,
        length: textLength,
      };
    }
    return {
      state: "not_submitted",
      session: latest.sessionId,
      reason: "live DOM read succeeded but no ChatGPT conversation was present",
      url,
      generating: output?.generating,
      length: textLength,
    };
  }

  if (latest.meta?.status === "error" && latest.meta?.response?.incompleteReason === "not-submitted") {
    return {
      state: "not_submitted",
      session: latest.sessionId,
      reason: "session metadata explicitly says not-submitted and live read failed",
      liveRead,
    };
  }
  if (
    latest.meta?.status === "error" &&
    !hasSubmittedRuntime(runtime) &&
    !hasSubmittedLogEvidence(latest.sessionDir) &&
    !isChatGptConversationUrl(liveState?.url || liveState?.tabUrl) &&
    sessionPrompt(latest.meta)
  ) {
    return {
      state: "not_submitted",
      session: latest.sessionId,
      reason: "matched browser session errored before any submitted runtime, live-state, or generation evidence",
      liveRead,
    };
  }

  return {
    state: "unknown",
    session: latest.sessionId,
    reason: "CLI failed and live verification could not prove submitted or not_submitted",
    liveRead,
  };
}

function renderSession(sessionId) {
  if (!sessionId) return { ok: false, reason: "no session id" };
  const result = spawnSync(process.execPath, [oracleCli, "session", sessionId, "--render"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  return { ok: result.status === 0, status: result.status };
}

function outputTokensForSession(meta) {
  const values = [
    meta?.usage?.outputTokens,
    ...(Array.isArray(meta?.models) ? meta.models.map((model) => model?.usage?.outputTokens) : []),
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function transcriptAnswerText(sessionDir) {
  if (!sessionDir) return null;
  const transcriptPath = join(sessionDir, "artifacts", "transcript.md");
  if (!existsSync(transcriptPath)) return null;
  const transcript = readFileSync(transcriptPath, "utf8");
  const marker = "\n## Answer\n\n";
  const index = transcript.indexOf(marker);
  return (index >= 0 ? transcript.slice(index + marker.length) : transcript).trim();
}

function answerCharsForSession(meta, sessionDir) {
  const transcriptAnswer = transcriptAnswerText(sessionDir);
  const values = [
    meta?.answerChars,
    meta?.response?.answerChars,
    ...(Array.isArray(meta?.models) ? meta.models.map((model) => model?.answerChars ?? model?.response?.answerChars) : []),
    transcriptAnswer?.length,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function shouldRejectSuspiciousCompletedAnswer(meta, args, sessionDir) {
  if (meta?.status !== "completed") return false;
  const outputTokens = outputTokensForSession(meta);
  const answerChars = answerCharsForSession(meta, sessionDir);
  if (outputTokens !== null && outputTokens > 8) return false;
  if (answerChars !== null && answerChars > 80) return false;
  if (outputTokens === null && answerChars === null) return false;
  const prompt = promptForArgs(args) || sessionPrompt(meta);
  const inputTokens = Number(meta?.usage?.inputTokens ?? 0) || Number(meta?.models?.[0]?.usage?.inputTokens ?? 0) || 0;
  const reviewLike = /review|검토|리뷰|계획|architecture|production|상용|품질/i.test(prompt);
  return inputTokens >= 1000 || prompt.length >= 500 || reviewLike;
}

function markSuspiciousCompletedAnswer(oracleHome, sessionId, meta, sessionDir) {
  if (!sessionId || !meta) return;
  const completedAt = new Date().toISOString();
  const answerText = transcriptAnswerText(sessionDir);
  const nextMeta = {
    ...meta,
    status: "error",
    completedAt,
    updatedAt: completedAt,
    errorMessage: "Completed browser session produced a suspiciously short answer.",
    response: { status: "error", incompleteReason: "suspicious-short-answer" },
    error: {
      category: "browser-automation",
      message: "Completed browser session produced a suspiciously short answer.",
      details: {
        code: "suspicious-short-answer",
        answerChars: answerText?.length ?? null,
        answerPreview: answerText?.slice(0, 160),
      },
    },
    models: Array.isArray(meta.models)
      ? meta.models.map((model) => ({
          ...model,
          status: "error",
          completedAt,
          response: { status: "error", incompleteReason: "suspicious-short-answer" },
          error: {
            category: "browser-automation",
            message: "Completed browser session produced a suspiciously short answer.",
            details: { code: "suspicious-short-answer" },
          },
        }))
      : meta.models,
  };
  writeJson(join(oracleHome, "sessions", sessionId, "meta.json"), nextMeta);
}

function submitLiveChatGptSession(sessionId) {
  if (!sessionId) return { ok: false, reason: "no session id" };
  const result = spawnSync(process.execPath, [
    join(scriptDir, "submit-live-chatgpt.mjs"),
    "--session",
    sessionId,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  let parsed = null;
  try {
    parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const url = parsed?.probe?.url || parsed?.submitted?.url;
  return {
    ok: result.status === 0 && Boolean(parsed?.submitted?.submitted) && isChatGptConversationUrl(url),
    status: result.status,
    submitted: parsed?.submitted,
    probe: parsed?.probe,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isChatGptConversationUrl(value) {
  return /chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)/i.test(String(value ?? ""));
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  const probe = spawnSync(
    process.platform === "win32" ? "powershell.exe" : "ps",
    process.platform === "win32"
      ? ["-NoProfile", "-Command", `if (Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`]
      : ["-p", String(numericPid)],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

function isLocalPortOpen(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) return false;
  const probe = spawnSync(
    process.platform === "win32" ? "powershell.exe" : "sh",
    process.platform === "win32"
      ? ["-NoProfile", "-Command", `$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', ${numericPort}); $client.Close(); exit 0 } catch { exit 1 }`]
      : ["-c", `nc -z 127.0.0.1 ${numericPort}`],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

function normalizePort(value) {
  const port = Number(String(value ?? "").trim());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function addCandidatePort(ports, value) {
  const port = normalizePort(value);
  if (port) ports.add(port);
}

function addPortsFromText(ports, text) {
  const source = String(text ?? "");
  for (const match of source.matchAll(/--remote-debugging-port=(\d{2,5})/g)) {
    addCandidatePort(ports, match[1]);
  }
}

function chromeProcessDebugPorts() {
  const ports = new Set();
  const oracleProfileNeedle = process.platform === "win32"
    ? "\\.oracle\\browser-profile"
    : "/.oracle/browser-profile";
  const probe = spawnSync(
    process.platform === "win32" ? "powershell.exe" : "sh",
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | " +
            "Where-Object { $_.CommandLine -match '--remote-debugging-port=\\d+' -and $_.CommandLine -match '\\\\.oracle\\\\browser-profile' } | " +
            "ForEach-Object { $_.CommandLine }",
        ]
      : ["-c", "ps -eo args= | grep '[c]hrome' | grep -- '--remote-debugging-port=' | grep -- '/.oracle/browser-profile'"],
    { encoding: "utf8" },
  );
  if (probe.status === 0) {
    addPortsFromText(ports, probe.stdout);
  }
  if (ports.size === 0 && oracleProfileNeedle) {
    addPortsFromText(ports, probe.stderr);
  }
  return [...ports];
}

function sessionCandidateDebugPorts(oracleHome) {
  const ports = new Set();
  const liveState = readJson(join(oracleHome, "live-chatgpt-state.json"));
  addCandidatePort(ports, liveState?.port);
  for (const item of listSessionDirs(oracleHome).slice(0, 80)) {
    const meta = readSessionMeta(oracleHome, item.sessionId);
    addCandidatePort(ports, meta?.browser?.runtime?.chromePort);
    addCandidatePort(ports, meta?.browser?.config?.remoteChrome?.port);
    const sessionLiveState = readJson(join(item.sessionDir, "live-state.json"));
    addCandidatePort(ports, sessionLiveState?.port);
  }
  return [...ports];
}

function browserConnectionPinned(args) {
  return (
    hasArg(args, "--browser-attach-running") ||
    hasArg(args, "--remote-chrome") ||
    hasArg(args, "--browser-port") ||
    hasArg(args, "--browser-debug-port") ||
    hasArg(args, "--browser-headless")
  );
}

function discoverAttachableOracleChromePort() {
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const ports = [
    ...chromeProcessDebugPorts(),
    ...sessionCandidateDebugPorts(oracleHome),
  ];
  for (const port of [...new Set(ports)]) {
    if (isLocalPortOpen(port)) return port;
  }
  return null;
}

function attachRunningArgs(args, port) {
  const next = withoutArgs(args, [
    "--browser-keep-browser",
    "--remote-chrome",
    "--browser-port",
    "--browser-debug-port",
  ]);
  if (!hasArg(next, "--browser-attach-running")) {
    next.push("--browser-attach-running");
  }
  next.push("--remote-chrome", `127.0.0.1:${port}`);
  return next;
}

function maybeAutoAttachBrowserRun(args) {
  if (!isBrowserRun(args)) return args;
  if (process.env.ORACLE_DISABLE_AUTO_ATTACH === "1") return args;
  if (browserConnectionPinned(args)) return args;
  const port = discoverAttachableOracleChromePort();
  if (!port) return args;
  console.error(`[oracle-wrapper] Found live Oracle Chrome DevTools port ${port}; attaching instead of launching a second browser.`);
  return attachRunningArgs(args, port);
}

function confirmedActiveGeneratingState(state, meta, sessionId) {
  if (!state?.generating || !recentEnough(state.observedAt, Number(process.env.ORACLE_LIVE_GENERATING_TTL_MS || 2 * 60 * 60 * 1000))) {
    return null;
  }
  const stateUrl = state.url || state.tabUrl;
  const portStillOpen = isLocalPortOpen(state.port);
  if (!portStillOpen) return null;

  if (isTerminalSession(meta) && !hasRecoverableGeneratingConversation(state, meta)) {
    return null;
  }

  const liveRead = sessionId ? readLiveSessionJson(sessionId) : null;
  if (!liveRead?.ok) return null;

  const output = liveRead.value;
  const liveUrl = output?.url || output?.tabUrl || stateUrl;
  if (!output?.generating || !isChatGptConversationUrl(liveUrl)) return null;

  return {
    url: liveUrl,
    title: output?.title || output?.tabTitle || state.title || state.tabTitle,
    observedAt: output?.observedAt || state.observedAt,
  };
}

function recoverableDisconnectedGeneratingState(state, meta, sessionDir) {
  if (!state?.generating || !recentEnough(state.observedAt, Number(process.env.ORACLE_LIVE_GENERATING_TTL_MS || 2 * 60 * 60 * 1000))) {
    return null;
  }
  const stateUrl = state.url || state.tabUrl;
  const hasConversationUrl = isChatGptConversationUrl(stateUrl);
  const hasLogEvidence = sessionDir ? Boolean(submittedLogObservedAt(sessionDir, Number(process.env.ORACLE_LIVE_GENERATING_TTL_MS || 2 * 60 * 60 * 1000))) : false;
  if (!hasConversationUrl && !hasLogEvidence) return null;
  if (isTerminalSession(meta) && !hasRecoverableGeneratingConversation(state, meta)) return null;
  return {
    url: stateUrl,
    title: state.title || state.tabTitle || meta?.options?.slug || meta?.promptPreview,
    observedAt: state.observedAt,
  };
}

function reconcileNotSubmittedBrowserSessions() {
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const sessionsDir = join(oracleHome, "sessions");
  if (!existsSync(sessionsDir)) return;
  for (const sessionId of readdirSync(sessionsDir)) {
    const sessionDir = join(sessionsDir, sessionId);
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const metaPath = join(sessionDir, "meta.json");
    const meta = readJson(metaPath);
    if (meta?.status !== "running" || (meta.mode !== "browser" && meta.engine !== "browser")) continue;
    const modelStates = Array.isArray(meta.models)
      ? meta.models.map((model) => {
          const sidecar = readJson(join(sessionDir, model.log?.path ? dirname(model.log.path) : "models", `${model.model}.json`));
          return sidecar ?? model;
        })
      : [];
    const allModelsNotSubmitted = modelStates.length > 0 && modelStates.every((model) =>
      model?.status === "error" && model?.response?.incompleteReason === "not-submitted"
    );
    const runtime = meta.browser?.runtime;
    // A live Chrome process alone does not mean the request is running. The
    // controller is the process that can still type/submit/capture. If it died
    // before promptSubmitted=true, treat the browser tab as abandoned instead
    // of blocking future runs forever.
    if (!allModelsNotSubmitted && isProcessAlive(runtime?.controllerPid)) continue;
    if (runtime?.promptSubmitted === true) continue;
    const liveState = readJson(join(sessionDir, "live-state.json"));
    if (liveState?.generating && liveState?.promptMatch === true) continue;
    const outputLog = join(sessionDir, "output.log");
    let outputSize = 0;
    try {
      outputSize = statSync(outputLog).size;
    } catch {
      outputSize = 0;
    }
    if (!allModelsNotSubmitted && hasSubmittedLogEvidence(sessionDir)) continue;
    const completedAt = new Date().toISOString();
    const nextMeta = {
      ...meta,
      status: "error",
      completedAt,
      errorMessage: "ChatGPT browser session did not submit a prompt or create a conversation.",
      response: { status: "error", incompleteReason: "not-submitted" },
      error: {
        category: "browser-automation",
        message: "ChatGPT browser session did not submit a prompt or create a conversation.",
        details: {
          stage: "submit-prompt",
          code: "not-submitted",
          runtime,
          liveState,
          outputSize,
        },
      },
      models: Array.isArray(meta.models)
        ? meta.models.map((model) => model.status === "running" || model.status === "pending"
          ? {
              ...model,
              status: "error",
              completedAt,
              response: { status: "error", incompleteReason: "not-submitted" },
              error: {
                category: "browser-automation",
                message: "ChatGPT browser session did not submit a prompt or create a conversation.",
                details: { stage: "submit-prompt", code: "not-submitted" },
              },
            }
          : model)
        : meta.models,
    };
    writeJson(metaPath, nextMeta);
  }
}

function findActiveBrowserRecoveryState() {
  reconcileNotSubmittedBrowserSessions();
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const maxAgeMs = Number(process.env.ORACLE_LIVE_GENERATING_TTL_MS || 2 * 60 * 60 * 1000);
  const liveState = readJson(join(oracleHome, "live-chatgpt-state.json"));
  const liveStateMeta = readSessionMeta(oracleHome, liveState?.session);
  const confirmedLiveState = confirmedActiveGeneratingState(liveState, liveStateMeta, liveState?.session);
  if (confirmedLiveState) {
    return {
      reason: "live ChatGPT tab is still generating",
      session: liveState.session,
      title: confirmedLiveState.title,
      url: confirmedLiveState.url,
      observedAt: confirmedLiveState.observedAt,
    };
  }

  const sessionsDir = join(oracleHome, "sessions");
  if (!existsSync(sessionsDir)) return null;
  for (const sessionId of readdirSync(sessionsDir)) {
    const sessionDir = join(sessionsDir, sessionId);
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readSessionMeta(oracleHome, sessionId);
    const sessionLiveState = readJson(join(sessionDir, "live-state.json"));
    const confirmedSessionLiveState = confirmedActiveGeneratingState(sessionLiveState, meta, sessionId);
    if (confirmedSessionLiveState) {
      return {
        reason: "session live ChatGPT tab is still generating",
        session: sessionId,
        title: confirmedSessionLiveState.title,
        url: confirmedSessionLiveState.url,
        observedAt: confirmedSessionLiveState.observedAt,
      };
    }

    if (isTerminalSession(meta)) continue;

    if (meta?.status === "running" && (meta.mode === "browser" || meta.engine === "browser")) {
      const runtime = meta?.browser?.runtime;
      const controllerAlive = isProcessAlive(runtime?.controllerPid);
      const chromePortOpen = isLocalPortOpen(runtime?.chromePort);
      const liveRead = chromePortOpen ? readLiveSessionJson(sessionId) : null;
      const liveUrl = liveRead?.ok ? liveRead.value?.url || liveRead.value?.tabUrl : null;
      if (liveRead?.ok && !liveRead.value?.generating) {
        continue;
      }
      if (!controllerAlive && !(liveRead?.ok && liveRead.value?.generating && isChatGptConversationUrl(liveUrl))) {
        continue;
      }
      return {
        reason: "stored browser session is still running",
        session: sessionId,
        title: meta.options?.slug || meta.promptPreview,
        url: liveUrl || meta.browser?.runtime?.tabUrl,
        observedAt: meta.updatedAt || meta.createdAt,
      };
    }

    try {
      const logPath = join(sessionDir, "output.log");
      const logStat = statSync(logPath);
      if (Date.now() - logStat.mtimeMs > maxAgeMs) continue;
      const logTail = readFileSync(logPath, "utf8").slice(-12000);
      const runtime = meta?.browser?.runtime;
      if (
        isLocalPortOpen(runtime?.chromePort)
        && /ChatGPT thinking|status=active|Stop generating|Finalizing answer|generating=true/i.test(logTail)
      ) {
        return {
          reason: "recent session log indicates ChatGPT was generating even if Chrome is no longer reachable",
          session: sessionId,
          title: meta?.options?.slug || meta?.promptPreview,
          url: meta?.browser?.runtime?.tabUrl,
          observedAt: logStat.mtime.toISOString(),
        };
      }
    } catch {
      // Missing logs are normal for failed launches.
    }
  }
  return null;
}

let cliArgs = withDefaultKeepBrowser(process.argv.slice(2));
if (cliArgs[0] === "status" || isBrowserRun(cliArgs)) {
  reconcileNotSubmittedBrowserSessions();
}
if (
  isBrowserRun(cliArgs) &&
  !cliArgs.includes("--force") &&
  process.env.ORACLE_ALLOW_BROWSER_DUPLICATE !== "1"
) {
  const active = findActiveBrowserRecoveryState();
  if (active) {
    console.error("Refusing to start a new Oracle browser run because a previous ChatGPT run may still be generating.");
    console.error(`Reason: ${active.reason}`);
    if (active.session) console.error(`Session: ${active.session}`);
    if (active.title) console.error(`Title: ${active.title}`);
    if (active.url) console.error(`URL: ${active.url}`);
    if (active.observedAt) console.error(`Observed: ${active.observedAt}`);
    console.error("Recover it first with:");
    if (active.session) {
      console.error(`  node "${join(scriptDir, "read-live-chatgpt.mjs")}" --session "${active.session}" --tail 40000`);
      console.error(`  node "${join(scriptDir, "run-oracle.mjs")}" session "${active.session}" --render`);
    } else {
      console.error(`  node "${join(scriptDir, "read-live-chatgpt.mjs")}" --title "ChatGPT" --tail 40000`);
    }
    console.error("To intentionally override this guard, set ORACLE_ALLOW_BROWSER_DUPLICATE=1.");
    process.exit(2);
  }
}
cliArgs = maybeAutoAttachBrowserRun(cliArgs);

if (handleLocalCompletedSessionRender(cliArgs)) {
  process.exit(0);
}

if (!existsSync(dependencyProbe)) {
  console.error("Installing patched Oracle runtime dependencies...");
  const install = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--omit=dev", "--ignore-scripts"],
    { cwd: oracleDir, stdio: "inherit" },
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

function runOracleCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [oracleCli, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

const runOracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
const runBaselineSessionIds = isBrowserRun(cliArgs) ? browserSessionIds(runOracleHome) : null;
const run = runOracleCli(cliArgs);
handleSessionRender(cliArgs, run.status);

function handleSuccessfulBrowserRun(args, baselineSessionIds) {
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const session = browserSessionForRun(oracleHome, args, baselineSessionIds);
  if (session?.meta?.status === "completed") {
    if (shouldRejectSuspiciousCompletedAnswer(session.meta, args, session.sessionDir)) {
      console.error(`[oracle-wrapper] completed browser session ${session.sessionId} produced a suspiciously short answer; rendering transcript and failing so callers do not treat it as valid.`);
      renderSession(session.sessionId);
      markSuspiciousCompletedAnswer(oracleHome, session.sessionId, session.meta, session.sessionDir);
      process.exit(3);
    }
    if (process.env.ORACLE_RENDER_COMPLETED_BROWSER === "1") {
      renderSession(session.sessionId);
    }
  }
}

function handleSessionRender(args, status) {
  if ((status ?? 1) !== 0 || !isSessionRender(args)) return;
  const sessionId = sessionIdForSessionCommand(args);
  if (!sessionId) return;
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const sessionDir = join(oracleHome, "sessions", sessionId);
  const meta = readSessionMeta(oracleHome, sessionId);
  if (!meta || !(meta.mode === "browser" || meta.engine === "browser")) return;
  if (!shouldRejectSuspiciousCompletedAnswer(meta, args, sessionDir)) return;
  console.error(`[oracle-wrapper] rendered browser session ${sessionId} produced a suspiciously short answer; marking it invalid.`);
  markSuspiciousCompletedAnswer(oracleHome, sessionId, meta, sessionDir);
  process.exit(3);
}

function handleLocalCompletedSessionRender(args) {
  if (!isSessionRender(args)) return false;
  const sessionId = sessionIdForSessionCommand(args);
  if (!sessionId) return false;
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const recovery = recoverLocalCompletedTranscript({
    oracleHome,
    sessionId,
    isProcessAlive,
    isPortOpen: isLocalPortOpen,
  });
  if (recovery.state !== "recovered" && recovery.state !== "rendered") return false;
  const action = recovery.state === "recovered" ? "Reconciled completed" : "Rendered verified";
  console.error(`[oracle-wrapper] ${action} local browser transcript for session ${sessionId}; skipped Chrome reattach.`);
  process.stdout.write(`${recovery.answer}\n`);
  return true;
}

function handleFailedBrowserRun(args, baselineSessionIds, allowRetry) {
  const verification = verifyBrowserSubmissionAfterFailure(args, baselineSessionIds);
  console.error(`[oracle-wrapper] post-failure submission verification: ${JSON.stringify(verification)}`);
  if (verification.state === "completed") {
    console.error("[oracle-wrapper] The matched browser session completed despite the CLI failure. Rendering/recovering the answer now.");
    const rendered = renderSession(verification.session);
    process.exit(rendered.ok ? 0 : (rendered.status ?? 1));
  } else if (verification.state === "submitted") {
    console.error("[oracle-wrapper] The browser command failed, but the prompt appears submitted. Do not retry blindly; recover/read this session first.");
    console.error(`[oracle-wrapper] Recover now with: node "${join(scriptDir, "run-oracle.mjs")}" session "${verification.session}" --render`);
  } else if (verification.state === "not_submitted") {
    if (!allowRetry) {
      console.error("[oracle-wrapper] The prompt is still not submitted after the one allowed recovery pass; refusing a second live-submit attempt.");
      return;
    }
    console.error("[oracle-wrapper] The prompt appears not submitted after live verification. Attempting automatic live-submit recovery.");
    const recovery = submitLiveChatGptSession(verification.session);
    console.error(`[oracle-wrapper] live-submit recovery result: ${JSON.stringify({
      ok: recovery.ok,
      status: recovery.status,
      submitted: recovery.submitted,
      probe: recovery.probe,
      stderr: recovery.stderr,
      parseError: recovery.parseError,
    })}`);
    if (recovery.ok) {
      console.error("[oracle-wrapper] The prompt was submitted by recovery. Do not start a duplicate request; read/recover this session for the answer.");
      process.exit(0);
    }
    if (
      allowRetry &&
      process.env.ORACLE_SKIP_ATTACH_FALLBACK_RETRY !== "1" &&
      !browserConnectionPinned(args)
    ) {
      const attachPort = discoverAttachableOracleChromePort();
      if (attachPort) {
        const attachArgs = attachRunningArgs(args, attachPort);
        console.error(`[oracle-wrapper] Automatic recovery did not submit the prompt. Retrying once via existing Oracle Chrome DevTools port ${attachPort}.`);
        const retryOracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
        const retryBaselineSessionIds = browserSessionIds(retryOracleHome);
        const retry = runOracleCli(attachArgs, {
          ORACLE_SKIP_ATTACH_FALLBACK_RETRY: "1",
          ORACLE_SKIP_NOT_SUBMITTED_RETRY: "1",
        });
        if ((retry.status ?? 1) === 0) {
          handleSuccessfulBrowserRun(attachArgs, retryBaselineSessionIds);
          process.exit(0);
        }
        handleFailedBrowserRun(attachArgs, retryBaselineSessionIds, false);
        process.exit(retry.status ?? 1);
      }
    }
    if (
      allowRetry &&
      process.env.ORACLE_SKIP_NOT_SUBMITTED_RETRY !== "1" &&
      !browserConnectionPinned(args)
    ) {
      console.error("[oracle-wrapper] Automatic recovery did not submit the prompt. Retrying once because submission was verified not_submitted.");
      const retryOracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
      const retryBaselineSessionIds = browserSessionIds(retryOracleHome);
      const retry = runOracleCli(args, { ORACLE_SKIP_NOT_SUBMITTED_RETRY: "1" });
      if ((retry.status ?? 1) === 0) {
        handleSuccessfulBrowserRun(args, retryBaselineSessionIds);
        process.exit(0);
      }
      handleFailedBrowserRun(args, retryBaselineSessionIds, false);
      process.exit(retry.status ?? 1);
    }
    console.error("[oracle-wrapper] Automatic recovery did not submit the prompt after the one allowed retry.");
  } else {
    console.error("[oracle-wrapper] Submission state is unknown. Inspect the live browser/session before retrying.");
  }
}

if (isBrowserRun(cliArgs) && (run.status ?? 0) === 0) {
  handleSuccessfulBrowserRun(cliArgs, runBaselineSessionIds);
}

if (isBrowserRun(cliArgs) && (run.status ?? 1) !== 0) {
  handleFailedBrowserRun(cliArgs, runBaselineSessionIds, true);
}

process.exit(run.status ?? 1);
