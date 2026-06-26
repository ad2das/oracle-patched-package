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
  if (
    liveState?.generating &&
    (!isTerminalSession(liveStateMeta) || hasRecoverableGeneratingConversation(liveState, liveStateMeta)) &&
    recentEnough(liveState.observedAt, maxAgeMs)
  ) {
    return {
      reason: "read-live-chatgpt previously observed generating=true",
      session: liveState.session,
      title: liveState.title || liveState.tabTitle,
      url: liveState.url || liveState.tabUrl,
      observedAt: liveState.observedAt,
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
    if (
      sessionLiveState?.generating &&
      (!isTerminalSession(meta) || hasRecoverableGeneratingConversation(sessionLiveState, meta)) &&
      recentEnough(sessionLiveState.observedAt, maxAgeMs)
    ) {
      return {
        reason: "session live-state recorded generating=true",
        session: sessionId,
        title: sessionLiveState.title || sessionLiveState.tabTitle,
        url: sessionLiveState.url || sessionLiveState.tabUrl,
        observedAt: sessionLiveState.observedAt,
      };
    }

    if (isTerminalSession(meta)) continue;

    if (meta?.status === "running" && (meta.mode === "browser" || meta.engine === "browser")) {
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

process.exit(run.status ?? 1);
