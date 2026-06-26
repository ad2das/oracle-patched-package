#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const titleFilter = argValue("--title", "ChatGPT");
const explicitPort = argValue("--port");
const sessionId = argValue("--session");
const tailChars = Number(argValue("--tail", "40000"));
const jsonOnly = args.includes("--json");
const noOpenMissing = args.includes("--no-open-missing");

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function oracleHomeDir() {
  return process.env.ORACLE_HOME_DIR || path.join(os.homedir(), ".oracle");
}

function readSessionMeta(id) {
  if (!id) return null;
  const metaPath = path.join(oracleHomeDir(), "sessions", id, "meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isTerminalSession(meta) {
  return meta?.status === "completed" || meta?.status === "error" || meta?.status === "cancelled";
}

function writeJsonIfPossible(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    // Recovery reads should never fail just because state persistence failed.
  }
}

function persistLiveState(output) {
  const observedAt = new Date().toISOString();
  const sessionMeta = readSessionMeta(output.session);
  const terminalButLiveConversation =
    isTerminalSession(sessionMeta) &&
    Boolean(output.url || output.tabUrl) &&
    /chatgpt\.com\/c\//i.test(`${output.url ?? ""}\n${output.tabUrl ?? ""}`);
  const generating = terminalButLiveConversation
    ? Boolean(output.generating)
    : isTerminalSession(sessionMeta) ? false : Boolean(output.generating);
  const state = {
    observedAt,
    generating,
    title: output.title,
    url: output.url,
    tabTitle: output.tabTitle,
    tabUrl: output.tabUrl,
    tabId: output.tabId,
    port: output.port,
    session: output.session,
    sessionStatus: sessionMeta?.status ?? output.sessionStatus,
    sessionError: output.sessionError,
    length: output.length,
  };
  writeJsonIfPossible(path.join(oracleHomeDir(), "live-chatgpt-state.json"), state);
  if (output.session) {
    writeJsonIfPossible(path.join(oracleHomeDir(), "sessions", output.session, "live-state.json"), state);
  }
}

function clearLiveStateAfterFailedRead(attempts) {
  const sessionMeta = readSessionMeta(sessionId);
  const sessionStillRunning = sessionMeta?.status === "running";
  const existingState = readJson(sessionId
    ? path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json")
    : path.join(oracleHomeDir(), "live-chatgpt-state.json"));
  if (
    existingState?.generating &&
    sessionMeta?.status === "error" &&
    existingState?.url &&
    /chatgpt\.com\/c\//i.test(existingState.url)
  ) {
    const preserved = {
      ...existingState,
      observedAt: new Date().toISOString(),
      sessionStatus: sessionMeta?.status,
      sessionError: "Live read failed, preserving previous generating conversation state instead of clearing it",
      attempts,
    };
    writeJsonIfPossible(path.join(oracleHomeDir(), "live-chatgpt-state.json"), preserved);
    if (sessionId) {
      writeJsonIfPossible(path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json"), preserved);
    }
    return;
  }
  const state = {
    observedAt: new Date().toISOString(),
    generating: sessionStillRunning,
    title: titleFilter,
    url: null,
    tabTitle: null,
    tabUrl: null,
    tabId: null,
    port: explicitPort,
    session: sessionId,
    sessionStatus: sessionMeta?.status,
    sessionError: sessionStillRunning
      ? "No live ChatGPT tab could be read; session is still running and must be recovered with session --render"
      : "No live ChatGPT tab could be read",
    length: 0,
    attempts,
  };
  writeJsonIfPossible(path.join(oracleHomeDir(), "live-chatgpt-state.json"), state);
  if (sessionId) {
    writeJsonIfPossible(path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json"), state);
  }
}

function readSessionRuntime(id) {
  return readSessionMeta(id)?.browser?.runtime ?? null;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sessionPrompt(meta) {
  return normalizeText(
    meta?.browser?.preparedSubmission?.prompt ||
    meta?.options?.preparedSubmission?.prompt ||
    meta?.options?.prompt ||
    meta?.prompt ||
    ""
  );
}

function promptNeedles(meta) {
  const prompt = sessionPrompt(meta);
  if (!prompt) return [];
  const needles = [];
  if (prompt.length >= 80) needles.push(prompt.slice(0, 160));
  for (const line of prompt.split(/\n+/).map(normalizeText)) {
    if (line.length >= 80) needles.push(line.slice(0, 160));
    if (needles.length >= 4) break;
  }
  return unique(needles.map(normalizeText).filter((item) => item.length >= 40));
}

function discoverPorts() {
  const sessionRuntime = readSessionRuntime(sessionId);
  if (explicitPort) return unique([explicitPort, sessionRuntime?.chromePort && String(sessionRuntime.chromePort)]);
  const ports = [];
  if (sessionRuntime?.chromePort) ports.push(String(sessionRuntime.chromePort));
  if (process.platform === "win32") {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ], { encoding: "utf8" });
    for (const match of output.matchAll(/--remote-debugging-port=(\d+)/g)) ports.push(match[1]);
  } else {
    const output = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    for (const match of output.matchAll(/--remote-debugging-port=(\d+)/g)) ports.push(match[1]);
  }
  return unique(ports);
}

function scoreTab(tab, runtime) {
  const title = tab.title ?? "";
  const url = tab.url ?? "";
  const haystack = `${title}\n${url}`.toLowerCase();
  const titleNeedle = titleFilter.toLowerCase();
  let score = 0;
  if (runtime?.chromeTargetId && tab.id === runtime.chromeTargetId) score += 1000;
  if (runtime?.tabUrl && url === runtime.tabUrl) score += 900;
  if (runtime?.conversationId && url.includes(runtime.conversationId)) score += 850;
  if (url.includes("chatgpt.com/c/")) score += 250;
  if (titleNeedle && haystack.includes(titleNeedle)) score += 100;
  if (url.includes("chatgpt.com")) score += 10;
  return score;
}

async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  }
  await send("Runtime.enable");
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  ws.close();
  return result.result?.result?.value;
}

async function listTabs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools list failed: HTTP ${response.status}`);
  return response.json();
}

async function openSessionTab(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`DevTools new tab failed: HTTP ${response.status}`);
  return response.json();
}

function buildDomProbeExpression(tail, needles = []) {
  const encodedNeedles = JSON.stringify(needles);
  return `(() => {
        const text = document.body.innerText || "";
        const normalizedText = text.replace(/\\s+/g, ' ').trim();
        const promptNeedles = ${encodedNeedles};
        const labels = [...document.querySelectorAll('button,[role="button"]')]
          .map((node) => (node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        const stopExists = labels.some((label) => /\\b(stop answering|stop generating)\\b|생성 중지|중지/i.test(label));
        const stoppedThinking = /\\bStopped thinking\\b/i.test(text);
        const thinkingText = !stoppedThinking && /\\b(Pro thinking|Finalizing answer|Thinking|I['’]m considering|I['’]m thinking|Still working|Working on)\\b|생각 중|응답 생성/i.test(text);
        const articles = [...document.querySelectorAll('article,[data-message-author-role],[data-turn]')]
          .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        return {
          title: document.title,
          url: location.href,
          length: text.length,
          promptMatch: promptNeedles.some((needle) => normalizedText.includes(needle)),
          generating: stopExists || thinkingText,
          stopExists,
          articleCount: articles.length,
          lastArticle: (articles.at(-1) || '').slice(-${Math.max(1000, tail)}),
          text: text.slice(-${Math.max(1000, tail)})
        };
      })()`;
}

function sessionMatchEvidence({ target, value, meta, runtime }) {
  if (!sessionId) return { matched: true, reason: "no session filter" };
  const targetUrl = String(target?.url ?? "");
  const valueUrl = String(value?.url ?? "");
  const urls = `${targetUrl}\n${valueUrl}`;
  if (runtime?.chromeTargetId && target?.id === runtime.chromeTargetId) {
    return { matched: true, reason: "chromeTargetId" };
  }
  if (runtime?.conversationId && urls.includes(runtime.conversationId)) {
    return { matched: true, reason: "conversationId" };
  }
  if (runtime?.tabUrl && (targetUrl === runtime.tabUrl || valueUrl === runtime.tabUrl)) {
    return { matched: true, reason: "tabUrl" };
  }
  const liveState = readJson(path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json"));
  const liveUrl = String(liveState?.url || liveState?.tabUrl || "");
  if (liveUrl && (targetUrl === liveUrl || valueUrl === liveUrl)) {
    return { matched: true, reason: "liveStateUrl" };
  }
  if (value?.promptMatch) {
    return { matched: true, reason: "promptFingerprint" };
  }
  return {
    matched: false,
    reason: "no session-specific evidence",
    expected: {
      chromeTargetId: runtime?.chromeTargetId,
      conversationId: runtime?.conversationId,
      tabUrl: runtime?.tabUrl,
      promptNeedles: promptNeedles(meta).length,
    },
    actual: {
      tabId: target?.id,
      tabTitle: target?.title,
      tabUrl: targetUrl,
      url: valueUrl,
      title: value?.title,
      promptMatch: Boolean(value?.promptMatch),
    },
  };
}

async function readTarget({ target, port, sessionMeta, sessionRuntime, needles, opened }) {
  const value = await cdpEvaluate(target.webSocketDebuggerUrl, buildDomProbeExpression(tailChars, needles));
  const sessionMatch = sessionMatchEvidence({
    target,
    value,
    meta: sessionMeta,
    runtime: sessionRuntime,
  });
  return {
    output: {
      port,
      session: sessionId,
      sessionStatus: sessionMeta?.status,
      sessionError: sessionMeta?.errorMessage,
      sessionMatch,
      opened,
      tabTitle: target.title,
      tabUrl: target.url,
      tabId: target.id,
      ...value,
    },
    sessionMatch,
  };
}

async function main() {
  const ports = discoverPorts();
  const sessionMeta = readSessionMeta(sessionId);
  const sessionRuntime = sessionMeta?.browser?.runtime ?? null;
  const sessionTabUrl = sessionRuntime?.tabUrl;
  const needles = promptNeedles(sessionMeta);
  const attempts = [];
  for (const port of ports) {
    try {
      const tabs = await listTabs(port);
      const ranked = tabs
        .map((tab) => ({ tab, score: scoreTab(tab, sessionRuntime) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      let target = ranked[0]?.tab;
      let opened = false;
      if (!target?.webSocketDebuggerUrl && sessionTabUrl && !noOpenMissing) {
        target = await openSessionTab(port, sessionTabUrl);
        opened = true;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!target?.webSocketDebuggerUrl) {
        attempts.push({
          port,
          error: "no matching ChatGPT tab",
          tabs: tabs.map((tab) => ({ title: tab.title, url: tab.url })).slice(0, 10),
        });
        continue;
      }
      let read = await readTarget({
        target,
        port,
        sessionMeta,
        sessionRuntime,
        needles,
        opened,
      });
      if (!read.sessionMatch.matched && sessionTabUrl && !opened && !noOpenMissing) {
        const openedTarget = await openSessionTab(port, sessionTabUrl);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        read = await readTarget({
          target: openedTarget,
          port,
          sessionMeta,
          sessionRuntime,
          needles,
          opened: true,
        });
      }
      if (!read.sessionMatch.matched) {
        attempts.push({
          port,
          error: "matched ChatGPT tab does not belong to requested Oracle session",
          session: sessionId,
          sessionMatch: read.sessionMatch,
          tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })).slice(0, 10),
        });
        continue;
      }
      const output = read.output;
      persistLiveState(output);
      if (jsonOnly) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`port=${output.port}`);
        console.log(`title=${output.title}`);
        console.log(`url=${output.url}`);
        console.log(`generating=${output.generating}`);
        console.log(`length=${output.length}`);
        console.log("--- text tail ---");
        console.log(output.text);
      }
      return;
    } catch (error) {
      attempts.push({ port, error: error instanceof Error ? error.message : String(error) });
    }
  }
  clearLiveStateAfterFailedRead(attempts);
  console.error(`No live ChatGPT tab could be read. Attempts: ${JSON.stringify(attempts)}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
