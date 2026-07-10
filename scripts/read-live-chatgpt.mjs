#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function sessionDir(id) {
  return id ? path.join(oracleHomeDir(), "sessions", id) : null;
}

function sessionLogText(id) {
  const dir = sessionDir(id);
  if (!dir) return "";
  const chunks = [];
  for (const filePath of [
    path.join(dir, "output.log"),
    path.join(dir, "models", "gpt-5.5-pro.log"),
    path.join(dir, "models", "gpt-5.2-instant.log"),
  ]) {
    try {
      chunks.push(fs.readFileSync(filePath, "utf8").slice(-24000));
    } catch {
      // Missing logs are normal.
    }
  }
  return chunks.join("\n");
}

function hasSubmittedLogEvidence(id) {
  return /ChatGPT thinking|status=active|Stop generating|Finalizing answer|generating=true|Waiting for ChatGPT response/i.test(sessionLogText(id));
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
    promptMatch: Boolean(output.promptMatch),
    assistantAfterPrompt: Boolean(output.assistantAfterPrompt),
  };
  writeJsonIfPossible(path.join(oracleHomeDir(), "live-chatgpt-state.json"), state);
  if (output.session) {
    writeJsonIfPossible(path.join(oracleHomeDir(), "sessions", output.session, "live-state.json"), state);
    reviveSessionMetaFromLiveConversation(output.session, output, state, sessionMeta);
  }
}

function conversationIdFromUrl(value) {
  const match = String(value ?? "").match(/chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)([^/?#]+)/i);
  return match?.[1];
}

function reviveSessionMetaFromLiveConversation(session, output, state, sessionMeta) {
  if (!session || !sessionMeta) return;
  const liveUrl = output.url || output.tabUrl;
  if (!/chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)/i.test(String(liveUrl ?? ""))) return;
  const runtime = sessionMeta.browser?.runtime ?? {};
  const sessionErrorText = `${sessionMeta.errorMessage ?? ""} ${sessionMeta.error?.message ?? ""}`;
  const explicitlyNotSubmitted = sessionMeta.response?.incompleteReason === "not-submitted" ||
    /Attachments did not finish uploading before timeout|not-submitted/i.test(sessionErrorText);
  // Target id / tab URL only identify the reused conversation. They do not prove that
  // this run's follow-up prompt was ever sent. promptSubmitted is written only after
  // a new-turn commit proof in the normal submitter or live recovery submitter.
  if (runtime.promptSubmitted !== true || !output.promptMatch || !output.sessionMatch?.matched) return;

  const metaPath = path.join(oracleHomeDir(), "sessions", session, "meta.json");
  const shouldRevive =
    sessionMeta.status === "running" ||
    (
      sessionMeta.status === "error" &&
      (
        explicitlyNotSubmitted
      )
    );
  if (!shouldRevive) return;

  const now = state.observedAt || new Date().toISOString();
  const nextRuntime = {
    ...runtime,
    promptSubmitted: true,
    tabUrl: liveUrl,
    conversationId: conversationIdFromUrl(liveUrl) ?? runtime.conversationId,
    chromePort: output.port ? Number(output.port) || output.port : runtime.chromePort,
    chromeTargetId: output.tabId ?? runtime.chromeTargetId,
  };
  const completed = Boolean(output.promptMatch) && !output.generating && Boolean(output.assistantAfterPrompt);
  const nextStatus = completed ? "completed" : "running";
  const nextResponse = completed
    ? { status: "completed", incompleteReason: "live-conversation-recovered" }
    : { status: "running", incompleteReason: "live-conversation-recovered" };
  const nextMeta = {
    ...sessionMeta,
    status: nextStatus,
    browser: {
      ...sessionMeta.browser,
      runtime: nextRuntime,
    },
    response: nextResponse,
    errorMessage: undefined,
    completedAt: completed ? now : undefined,
    updatedAt: now,
    models: Array.isArray(sessionMeta.models)
      ? sessionMeta.models.map((model) => model.status === "running" || model.status === "pending" || model.response?.incompleteReason === "not-submitted"
        ? {
            ...model,
            status: nextStatus,
            completedAt: completed ? now : undefined,
            response: nextResponse,
            error: undefined,
          }
        : model)
      : sessionMeta.models,
  };
  writeJsonIfPossible(metaPath, nextMeta);
  for (const model of nextMeta.models ?? []) {
    if (!model?.model) continue;
    const sidecarPath = path.join(oracleHomeDir(), "sessions", session, "models", `${model.model}.json`);
    const sidecar = readJson(sidecarPath);
    if (!sidecar) continue;
    writeJsonIfPossible(sidecarPath, {
      ...sidecar,
      status: model.status,
      completedAt: model.completedAt,
      response: model.response,
      error: model.error,
    });
  }
}

function clearLiveStateAfterFailedRead(attempts) {
  const sessionMeta = readSessionMeta(sessionId);
  const sessionStillRunning = sessionMeta?.status === "running";
  const submittedLogEvidence = hasSubmittedLogEvidence(sessionId);
  const existingState = readJson(sessionId
    ? path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json")
    : path.join(oracleHomeDir(), "live-chatgpt-state.json"));
  if (
    (existingState?.generating || submittedLogEvidence) &&
    (sessionStillRunning || sessionMeta?.status === "error") &&
    (
      submittedLogEvidence ||
      (
        existingState?.url &&
        /chatgpt\.com\/c\//i.test(existingState.url)
      )
    )
  ) {
    const preserved = {
      ...existingState,
      observedAt: new Date().toISOString(),
      generating: true,
      sessionStatus: sessionMeta?.status,
      sessionError: submittedLogEvidence
        ? "Live read failed, preserving submitted ChatGPT generation evidence even though Chrome is unreachable"
        : "Live read failed, preserving previous generating conversation state instead of clearing it",
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
  const meta = readSessionMeta(id);
  return resolveSessionRuntimeForRecovery(meta);
}

function isChatGptConversationUrl(value) {
  return /chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)[^/?#]+/i.test(String(value ?? ""));
}

export function resolveSessionRuntimeForRecovery(meta) {
  if (!meta) return null;
  const runtime = meta?.browser?.runtime ?? {};
  const config = meta?.browser?.config ?? meta?.options?.browserConfig ?? {};
  const remoteChrome = config.remoteChrome ?? {};
  const archiveConversationUrl = meta?.browser?.archive?.conversationUrl;
  const preferredConversationUrl = [
    runtime.tabUrl,
    archiveConversationUrl,
    config.browserTabRef,
  ].find(isChatGptConversationUrl);
  const selectedTabUrl = preferredConversationUrl ?? runtime.tabUrl ?? config.browserTabRef;
  const selectedConversationId = conversationIdFromUrl(selectedTabUrl);
  const enriched = {
    ...runtime,
    chromePort: runtime.chromePort ?? remoteChrome.port,
    chromeHost: runtime.chromeHost ?? remoteChrome.host,
    // Archive metadata is written from the live DOM and can retain the real
    // /c/... URL even when the controller's last runtime hint regressed to /.
    tabUrl: selectedTabUrl,
    conversationId: selectedConversationId ?? runtime.conversationId,
  };
  return Object.values(enriched).some((value) => value != null && value !== "") ? enriched : null;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function isGenerationStatusTextForTest(value) {
  const text = normalizeText(value).replace(/[.…·•]+$/u, "").trim();
  if (!text || text.length > 160) return false;
  if (/^(?:pro\s+)?(?:thinking|finalizing(?:\s+the)?\s+answer|still\s+working|working\s+on(?:\s+it)?|i['’]m\s+(?:thinking|considering))$/i.test(text)) {
    return true;
  }
  return /^(?:pro\s*)?(?:생각(?:하(?:는|고\s*있는)?)?\s*중|(?:최종\s*)?(?:답변|응답)(?:을)?\s*(?:마무리(?:하(?:는|고\s*있는)?)?|생성(?:하(?:는|고\s*있는)?)?|작성(?:하(?:는|고\s*있는)?)?)\s*중|마무리\s*중)$/iu.test(text);
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

export function selectSessionTargetForRecovery(tabs, runtime) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const preferredUrl = String(runtime?.tabUrl ?? "");
  const preferredConversationId = runtime?.conversationId ?? conversationIdFromUrl(preferredUrl);
  if (isChatGptConversationUrl(preferredUrl)) {
    const conversationTarget = tabs.find((tab) => {
      const tabUrl = String(tab?.url ?? "");
      return tabUrl === preferredUrl || (
        preferredConversationId && conversationIdFromUrl(tabUrl) === preferredConversationId
      );
    });
    // A stale root target must not outrank the persisted conversation. Returning
    // null makes the caller open the authoritative /c/... URL immediately.
    return conversationTarget ?? null;
  }
  return tabs
    .map((tab) => ({ tab, score: scoreTab(tab, runtime) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.tab ?? null;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDomProbeExpression(tail, needles = []) {
  const encodedNeedles = JSON.stringify(needles);
  return `(() => {
        const text = document.body.innerText || "";
        const promptNeedles = ${encodedNeedles};
        const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const isVisible = (node) => {
          if (!(node instanceof Element)) return false;
          const style = window.getComputedStyle(node);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const isGenerationStatusText = (value) => {
          const candidate = normalize(value).replace(/[.…·•]+$/u, '').trim();
          if (!candidate || candidate.length > 160) return false;
          if (/^(?:pro\\s+)?(?:thinking|finalizing(?:\\s+the)?\\s+answer|still\\s+working|working\\s+on(?:\\s+it)?|i['’]m\\s+(?:thinking|considering))$/i.test(candidate)) return true;
          return /^(?:pro\\s*)?(?:생각(?:하(?:는|고\\s*있는)?)?\\s*중|(?:최종\\s*)?(?:답변|응답)(?:을)?\\s*(?:마무리(?:하(?:는|고\\s*있는)?)?|생성(?:하(?:는|고\\s*있는)?)?|작성(?:하(?:는|고\\s*있는)?)?)\\s*중|마무리\\s*중)$/iu.test(candidate);
        };
        const labels = [...document.querySelectorAll('button,[role="button"]')]
          .map((node) => (node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        const stopExists = labels.some((label) => /\\b(stop answering|stop generating)\\b|생성 중지|중지/i.test(label));
        const assistantTurnNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        const statusNodes = [...document.querySelectorAll(
          '[role="status"],[aria-live="polite"],[data-testid*="thinking"],[data-testid*="reasoning"],span.loading-shimmer'
        )];
        const generationCandidates = [...statusNodes, ...assistantTurnNodes.slice(-1)].filter(isVisible);
        let generationStatusText = '';
        for (let index = generationCandidates.length - 1; index >= 0; index -= 1) {
          const candidate = normalize(generationCandidates[index].innerText || generationCandidates[index].textContent || '');
          if (isGenerationStatusText(candidate)) {
            generationStatusText = candidate;
            break;
          }
        }
        const thinkingText = Boolean(generationStatusText);
        const articles = [...document.querySelectorAll('article,[data-message-author-role],[data-turn]')]
          .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"], [data-testid^="conversation-turn-"] .markdown, .markdown.prose, [class*=markdown][class*=prose]')]
          .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter((value) => value && !/^(Pro|Share|ChatGPT can make mistakes)/i.test(value));
        const userMessages = [...document.querySelectorAll('[data-message-author-role="user"]')]
          .map((node) => (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        const roleTurns = [...document.querySelectorAll('[data-message-author-role]')]
          .map((node) => ({
            role: node.getAttribute('data-message-author-role') || '',
            text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
          }))
          .filter((turn) => turn.text);
        let matchingUserTurn = -1;
        for (let index = roleTurns.length - 1; index >= 0; index -= 1) {
          const turn = roleTurns[index];
          if (turn.role === 'user' && promptNeedles.some((needle) => turn.text.includes(needle))) {
            matchingUserTurn = index;
            break;
          }
        }
        const assistantsAfterPrompt = matchingUserTurn >= 0
          ? roleTurns.slice(matchingUserTurn + 1).filter((turn) => turn.role === 'assistant' && turn.text)
          : [];
        const assistantAfterPrompt = assistantsAfterPrompt.at(-1)?.text || "";
        const lastAssistantMessage = promptNeedles.length > 0
          ? assistantAfterPrompt
          : (assistantMessages.at(-1) || "");
        return {
          title: document.title,
          url: location.href,
          length: text.length,
          // Match only committed user turns. The active composer is part of body.innerText
          // and must never revive a typed-but-unsent follow-up as submitted.
          promptMatch: promptNeedles.some((needle) => userMessages.some((message) => message.includes(needle))),
          generating: stopExists || thinkingText,
          stopExists,
          thinkingStatusVisible: thinkingText,
          generationStatusText,
          articleCount: articles.length,
          assistantCount: assistantMessages.length,
          userCount: userMessages.length,
          assistantAfterPrompt: Boolean(assistantAfterPrompt),
          conversationLoaded: articles.length > 0 || assistantMessages.length > 0 || userMessages.length > 0,
          lastAssistantMessage: lastAssistantMessage.slice(-${Math.max(1000, tail)}),
          lastArticle: (articles.at(-1) || '').slice(-${Math.max(1000, tail)}),
          text: text.slice(-${Math.max(1000, tail)})
        };
      })()`;
}

function sessionMatchEvidence({ target, value, meta, runtime, requireSessionFilter = Boolean(sessionId) }) {
  if (!requireSessionFilter) return { matched: true, reason: "no session filter" };
  const targetUrl = String(target?.url ?? "");
  const valueUrl = String(value?.url ?? "");
  const urls = `${targetUrl}\n${valueUrl}`;
  const liveConversationUrl = /chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)/i.test(`${targetUrl}\n${valueUrl}`);
  const hasSubmittedRuntime = runtime?.promptSubmitted === true;
  const expectedConversationId = runtime?.conversationId;
  const actualConversationId = conversationIdFromUrl(valueUrl) || conversationIdFromUrl(targetUrl);
  if (expectedConversationId && actualConversationId !== expectedConversationId) {
    return {
      matched: false,
      reason: actualConversationId ? "conversationId-mismatch" : "expected-conversation-not-loaded",
      expected: { conversationId: expectedConversationId, tabUrl: runtime?.tabUrl },
      actual: { conversationId: actualConversationId, tabId: target?.id, tabTitle: target?.title, tabUrl: targetUrl, url: valueUrl },
    };
  }
  if (runtime?.conversationId && urls.includes(runtime.conversationId)) {
    return { matched: true, reason: "conversationId" };
  }
  if (runtime?.tabUrl && (targetUrl === runtime.tabUrl || valueUrl === runtime.tabUrl)) {
    return { matched: true, reason: "tabUrl" };
  }
  if (runtime?.chromeTargetId && target?.id === runtime.chromeTargetId) {
    return { matched: true, reason: "chromeTargetId" };
  }
  const liveState = readJson(path.join(oracleHomeDir(), "sessions", sessionId, "live-state.json"));
  const liveUrl = String(liveState?.url || liveState?.tabUrl || "");
  if (liveUrl && (targetUrl === liveUrl || valueUrl === liveUrl)) {
    return { matched: true, reason: "liveStateUrl" };
  }
  if (value?.promptMatch && (!liveConversationUrl || hasSubmittedRuntime)) {
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

export function sessionMatchEvidenceForTest(input) {
  return sessionMatchEvidence({ ...input, requireSessionFilter: true });
}

async function readTarget({ target, port, sessionMeta, sessionRuntime, needles, opened }) {
  let value = null;
  let sessionMatch = null;
  const startedAt = Date.now();
  const maxWaitMs = sessionId ? 60000 : opened ? 30000 : 8000;
  let reloadedEmptyConversation = false;
  do {
    value = await cdpEvaluate(target.webSocketDebuggerUrl, buildDomProbeExpression(tailChars, needles));
    sessionMatch = sessionMatchEvidence({
      target,
      value,
      meta: sessionMeta,
      runtime: sessionRuntime,
    });
    const hasConversationContent =
      value?.conversationLoaded ||
      value?.promptMatch ||
      Number(value?.length ?? 0) > 3000;
    if (!sessionId || !sessionMatch.matched || hasConversationContent) break;
    const valueUrl = String(value?.url || target.url || "");
    if (
      !reloadedEmptyConversation &&
      /chatgpt\.com\/c\//i.test(valueUrl) &&
      !hasConversationContent &&
      Date.now() - startedAt > 5000
    ) {
      reloadedEmptyConversation = true;
      await cdpEvaluate(target.webSocketDebuggerUrl, "location.reload(); true");
      await wait(5000);
      continue;
    }
    await wait(1000);
  } while (Date.now() - startedAt < maxWaitMs);
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
  const sessionRuntime = readSessionRuntime(sessionId);
  const sessionTabUrl = sessionRuntime?.tabUrl;
  const needles = promptNeedles(sessionMeta);
  const attempts = [];
  for (const port of ports) {
    try {
      const tabs = await listTabs(port);
      let target = selectSessionTargetForRecovery(tabs, sessionRuntime);
      let opened = false;
      if (
        !target?.webSocketDebuggerUrl &&
        isChatGptConversationUrl(sessionTabUrl) &&
        !noOpenMissing
      ) {
        target = await openSessionTab(port, sessionTabUrl);
        opened = true;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
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

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
