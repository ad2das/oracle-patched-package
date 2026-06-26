#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

function isBrowserRun(args) {
  const first = args.find((arg) => !arg.startsWith("-"));
  if (first === "session" || first === "status" || first === "serve" || first === "docs") return false;
  return argValue(args, "--engine") === "browser" || argValue(args, "-e") === "browser";
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

function newestBrowserSession(oracleHome) {
  for (const item of listSessionDirs(oracleHome)) {
    const meta = readSessionMeta(oracleHome, item.sessionId);
    if (meta?.mode === "browser" || meta?.engine === "browser") return { ...item, meta };
  }
  return null;
}

function hasSubmittedRuntime(runtime) {
  return Boolean(
    runtime?.promptSubmitted === true ||
    runtime?.conversationId ||
    isChatGptConversationUrl(runtime?.tabUrl)
  );
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

function verifyLatestBrowserSubmissionAfterFailure() {
  const oracleHome = process.env.ORACLE_HOME_DIR || join(homedir(), ".oracle");
  const latest = newestBrowserSession(oracleHome);
  if (!latest) return { state: "unknown", reason: "no browser session found" };

  const runtime = latest.meta?.browser?.runtime;
  const liveState = readJson(join(latest.sessionDir, "live-state.json"));
  if (hasSubmittedRuntime(runtime)) {
    return {
      state: "submitted",
      session: latest.sessionId,
      reason: "session runtime recorded promptSubmitted/conversation evidence",
      url: runtime?.tabUrl,
      promptSubmitted: runtime?.promptSubmitted,
    };
  }
  if (liveState?.url && isChatGptConversationUrl(liveState.url)) {
    return {
      state: "submitted",
      session: latest.sessionId,
      reason: "live-state recorded ChatGPT conversation URL",
      url: liveState.url,
      generating: liveState.generating,
    };
  }

  const liveRead = readLiveSessionJson(latest.sessionId);
  if (liveRead.ok) {
    const output = liveRead.value;
    const url = output?.url || output?.tabUrl;
    const textLength = Number(output?.length ?? 0) || 0;
    if (isChatGptConversationUrl(url) && (output?.generating || textLength > 0)) {
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

  return {
    state: "unknown",
    session: latest.sessionId,
    reason: "CLI failed and live verification could not prove submitted or not_submitted",
    liveRead,
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
    const runtime = meta.browser?.runtime;
    // A live Chrome process alone does not mean the request is running. The
    // controller is the process that can still type/submit/capture. If it died
    // before promptSubmitted=true, treat the browser tab as abandoned instead
    // of blocking future runs forever.
    if (isProcessAlive(runtime?.controllerPid)) continue;
    if (runtime?.promptSubmitted === true || isChatGptConversationUrl(runtime?.tabUrl) || runtime?.conversationId) continue;
    const liveState = readJson(join(sessionDir, "live-state.json"));
    const liveUrl = liveState?.url || liveState?.tabUrl;
    if (liveState?.generating || isChatGptConversationUrl(liveUrl)) continue;
    const outputLog = join(sessionDir, "output.log");
    let outputSize = 0;
    try {
      outputSize = statSync(outputLog).size;
    } catch {
      outputSize = 0;
    }
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
      if (!controllerAlive && !(liveRead?.ok && liveRead.value?.generating && isChatGptConversationUrl(liveUrl))) {
        continue;
      }
      return {
        reason: "stored browser session is still running",
        session: sessionId,
        title: meta.options?.slug || meta.promptPreview,
        url: meta.browser?.runtime?.tabUrl,
        observedAt: meta.updatedAt || meta.createdAt,
      };
    }

    try {
      const logPath = join(sessionDir, "output.log");
      const logStat = statSync(logPath);
      if (Date.now() - logStat.mtimeMs > maxAgeMs) continue;
      const logTail = readFileSync(logPath, "utf8").slice(-12000);
      if (/ChatGPT thinking|status=active|Stop generating|Finalizing answer|generating=true/i.test(logTail)) {
        const runtime = meta?.browser?.runtime;
        if (!isProcessAlive(runtime?.controllerPid) && !isLocalPortOpen(runtime?.chromePort)) continue;
        return {
          reason: "recent session log indicates ChatGPT was generating",
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

const cliArgs = process.argv.slice(2);
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

const run = spawnSync(process.execPath, [oracleCli, ...cliArgs], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

if (isBrowserRun(cliArgs) && (run.status ?? 1) !== 0) {
  const verification = verifyLatestBrowserSubmissionAfterFailure();
  console.error(`[oracle-wrapper] post-failure submission verification: ${JSON.stringify(verification)}`);
  if (verification.state === "submitted") {
    console.error("[oracle-wrapper] The browser command failed, but the prompt appears submitted. Do not retry blindly; recover/read this session first.");
  } else if (verification.state === "not_submitted") {
    console.error("[oracle-wrapper] The prompt appears not submitted after live verification. It is safe to retry this request.");
  } else {
    console.error("[oracle-wrapper] Submission state is unknown. Inspect the live browser/session before retrying.");
  }
}

process.exit(run.status ?? 1);
