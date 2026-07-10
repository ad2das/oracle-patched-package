#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(scriptDir, "..", "oracle-patched", "package.json"));
const WebSocket = require("ws");

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const sessionId = argValue("--session");
if (!sessionId) {
  console.error("Usage: submit-live-chatgpt.mjs --session <oracle-session-id>");
  process.exit(2);
}

const oracleHome = process.env.ORACLE_HOME_DIR || path.join(os.homedir(), ".oracle");
const sessionDir = path.join(oracleHome, "sessions", sessionId);
const metaPath = path.join(sessionDir, "meta.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const runtime = meta.browser?.runtime ?? {};
const browserConfig = meta.browser?.config ?? meta.options?.browserConfig ?? {};
const preparedSubmission = meta.browser?.preparedSubmission ?? meta.options?.preparedSubmission ?? {};
const prompt = preparedSubmission.prompt || meta.options?.prompt || "";
const remoteChrome = browserConfig.remoteChrome ?? {};
const port = runtime.chromePort ?? remoteChrome.port;
const host = runtime.chromeHost ?? remoteChrome.host ?? "127.0.0.1";
const configuredTabRef = runtime.tabUrl ?? browserConfig.browserTabRef;

if (!port || !prompt) {
  console.error(`Session has no Chrome port or prompt to submit. port=${Boolean(port)} prompt=${Boolean(prompt)}`);
  process.exit(2);
}

async function listTabs() {
  const response = await fetch(`http://${host}:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools list failed: HTTP ${response.status}`);
  return response.json();
}

function scoreTab(tab) {
  let score = 0;
  if (runtime.chromeTargetId && tab.id === runtime.chromeTargetId) score += 1000;
  if (tab.url === runtime.tabUrl) score += 500;
  if (configuredTabRef && tab.url === configuredTabRef) score += 450;
  if (/chatgpt\.com/i.test(tab.url ?? "")) score += 100;
  return score;
}

async function withCdp(webSocketDebuggerUrl, task) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };
  try {
    await send("Runtime.enable");
    await send("Input.setIgnoreInputEvents", { ignore: false });
    return await task(send);
  } finally {
    ws.close();
  }
}

function prepareComposerExpression() {
  return `(() => {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const dispatchInput = (node) => {
      try {
        node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '', inputType: 'deleteContentBackward' }));
      } catch {}
      try {
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
      } catch {
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const input = candidates.find(isVisible) || candidates[0];
    if (!input) return { ready: false, reason: 'composer-missing', url: location.href };
    input.focus?.();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      input.value = '';
    } else {
      input.textContent = '';
      const selection = document.getSelection?.();
      const range = document.createRange?.();
      if (selection && range) {
        range.selectNodeContents(input);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    dispatchInput(input);
    return { ready: true, url: location.href };
  })()`;
}

function composerTextExpression() {
  return `(() => {
    const selectors = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];
    const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const node = nodes.find((item) => {
      const rect = item.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0;
    }) || nodes[0];
    return {
      text: node ? ('value' in node ? node.value : node.innerText || node.textContent || '') : '',
      url: location.href,
    };
  })()`;
}

function attachmentProofExpression(expectedNames) {
  const names = expectedNames.map((name) => path.basename(String(name ?? ""))).filter(Boolean);
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const expected = ${JSON.stringify(names)}.map((name) => {
      const normalized = normalize(name);
      return { normalized, stem: normalized.replace(/\\.[a-z0-9]{1,10}$/i, '') };
    });
    const prompts = Array.from(document.querySelectorAll('#prompt-textarea,textarea,[contenteditable="true"],[role="textbox"]'));
    const prompt = prompts.find((node) => {
      const rect = node.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0;
    }) || prompts[0];
    const scope = prompt?.closest?.('form')?.parentElement || prompt?.closest?.('form') || document;
    const tileNames = Array.from(scope.querySelectorAll('[role="group"][class*="file-tile"]'))
      .map((node) => normalize(
        (node.getAttribute('aria-label') || '') + ' ' + (node.innerText || node.textContent || '')
      ))
      .filter(Boolean);
    const inputNames = Array.from(scope.querySelectorAll('input[type="file"]')).flatMap((input) =>
        Array.from(input.files || []).map((file) => file?.name || '')
      ).map(normalize).filter(Boolean);
    const matches = (item, value) =>
      value.includes(item.normalized) || (item.stem.length >= 6 && value.includes(item.stem))
    ;
    const missing = expected.filter((item) => !tileNames.some((value) => matches(item, value)));
    const duplicates = expected.filter((item) => tileNames.filter((value) => matches(item, value)).length > 1);
    return {
      ok: missing.length === 0 && duplicates.length === 0,
      observed: tileNames,
      inputNames,
      missing: missing.map((item) => item.normalized),
      duplicates: duplicates.map((item) => item.normalized),
    };
  })()`;
}

function sendExpression() {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const send = buttons.find((button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.textContent]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const rect = button.getBoundingClientRect?.();
      const visible = rect && rect.width > 0 && rect.height > 0;
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled');
      return visible && !disabled && /(send|submit|전송|보내기|arrow-up|composer-submit)/i.test(label);
    });
    if (send) {
      send.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      send.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      send.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      send.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      send.click();
      return { submitted: true, method: 'button', url: location.href };
    }
    return { submitted: false, reason: 'send-button-missing', url: location.href };
  })()`;
}

function probeExpression(expectedPrompt, baselineUserCount = -1) {
  const expectedPrefix = String(expectedPrompt ?? "").replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
  return `(() => {
    const text = document.body.innerText || '';
    const composerNodes = [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ].flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const composer = composerNodes.find((node) => {
      const rect = node.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0;
    }) || composerNodes[0];
    const composerText = composer ? ('value' in composer ? composer.value : composer.innerText || composer.textContent || '') : '';
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .map((node) => [node.getAttribute('aria-label'), node.textContent].filter(Boolean).join(' '));
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const expectedPrefix = ${JSON.stringify(expectedPrefix)};
    const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .map((node) => normalize(node.innerText || node.textContent || ''))
      .filter(Boolean);
    const promptMatch = expectedPrefix.length > 30 && userMessages.some((value) => value.includes(expectedPrefix));
    const lastUser = userMessages.at(-1) || '';
    const newPromptMatch = userMessages.length > ${Number(baselineUserCount)} &&
      expectedPrefix.length > 30 && lastUser.includes(expectedPrefix);
    return {
      url: location.href,
      title: document.title,
      generating: buttons.some((label) => /stop generating|stop answering|생성 중지|중지/i.test(label)) || /thinking|finalizing answer|응답 생성|생각 중/i.test(text),
      textLength: text.length,
      composerLength: composerText.trim().length,
      userCount: userMessages.length,
      promptMatch,
      newPromptMatch,
    };
  })()`;
}

function probeShowsSubmitted(value) {
  // The same prompt may already exist in a reused conversation. Only a user-turn
  // count advance after this recovery attempt proves that this attempt submitted it.
  return value?.newPromptMatch === true;
}

const tabs = await listTabs();
const controllableTabs = tabs.filter((item) => item.webSocketDebuggerUrl);
const configuredTab = configuredTabRef
  ? controllableTabs.find((item) => item.url === configuredTabRef || item.id === configuredTabRef)
  : null;
const tab = configuredTabRef ? configuredTab : controllableTabs
  .map((item) => ({ item, score: scoreTab(item) }))
  .sort((a, b) => b.score - a.score)[0]?.item;

if (!tab) {
  console.error("No ChatGPT DevTools tab found for session.");
  process.exit(1);
}

const result = await withCdp(tab.webSocketDebuggerUrl, async (send) => {
  const initial = await send("Runtime.evaluate", {
    expression: probeExpression(prompt, -1),
    returnByValue: true,
    awaitPromise: true,
  });
  const initialValue = initial.result?.result?.value ?? {};
  const baselineUserCount = Number(initialValue.userCount ?? 0) || 0;
  if (runtime.promptSubmitted === true && initialValue.promptMatch) {
    return {
      submitted: { submitted: true, method: "existing-prompt-proof", url: initialValue.url },
      probe: initialValue,
    };
  }
  const expectedAttachments = Array.isArray(preparedSubmission.attachments)
    ? preparedSubmission.attachments.map((item) => item?.displayPath || item?.path).filter(Boolean)
    : [];
  if (expectedAttachments.length > 0) {
    const attachmentProof = await send("Runtime.evaluate", {
      expression: attachmentProofExpression(expectedAttachments),
      returnByValue: true,
      awaitPromise: true,
    });
    const attachmentValue = attachmentProof.result?.result?.value;
    if (!attachmentValue?.ok) {
      return {
        submitted: {
          submitted: false,
          reason: "prepared-attachments-missing",
          missing: attachmentValue?.missing,
          observed: attachmentValue?.observed,
          url: initialValue.url,
        },
        probe: initialValue,
      };
    }
  }
  const prepared = await send("Runtime.evaluate", {
    expression: prepareComposerExpression(),
    returnByValue: true,
    awaitPromise: true,
  });
  const preparedValue = prepared.result?.result?.value;
  let submittedValue = preparedValue?.ready
    ? { submitted: false, reason: "not-sent-yet", url: preparedValue.url }
    : { submitted: false, reason: preparedValue?.reason ?? "composer-missing", url: preparedValue?.url };
  if (preparedValue?.ready) {
    await send("Input.insertText", { text: prompt });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const composer = await send("Runtime.evaluate", {
      expression: composerTextExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    const composerText = composer.result?.result?.value?.text ?? "";
    const expectedPrefix = prompt.trim().slice(0, 80);
    if (!composerText.includes(expectedPrefix)) {
      submittedValue = {
        submitted: false,
        reason: "prompt-insert-verification-failed",
        composerLength: composerText.length,
        expectedPrefix,
        url: composer.result?.result?.value?.url,
      };
    } else {
      const clicked = expectedAttachments.length > 0
        ? null
        : await send("Runtime.evaluate", {
            expression: sendExpression(),
            returnByValue: true,
            awaitPromise: true,
          });
      const dispatched = clicked?.result?.result?.value ?? { submitted: false, reason: "attachment-enter-required" };
      submittedValue = {
        submitted: false,
        sendDispatched: Boolean(dispatched?.submitted),
        method: dispatched?.method,
        reason: dispatched?.reason ?? "awaiting-current-turn-proof",
        url: dispatched?.url,
      };
      if (!dispatched?.submitted) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        submittedValue = {
          submitted: false,
          sendDispatched: true,
          method: "cdp-enter",
          reason: "awaiting-current-turn-proof",
          url: composer.result?.result?.value?.url,
        };
      }
    }
  }
  let probe = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    probe = await send("Runtime.evaluate", {
      expression: probeExpression(prompt, baselineUserCount),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = probe.result?.result?.value;
    if (probeShowsSubmitted(value)) {
      submittedValue = {
        submitted: true,
        sendDispatched: submittedValue?.sendDispatched,
        method: "current-user-turn-proof",
        reason: submittedValue?.reason,
        url: value?.url,
      };
      break;
    }
  }
  return {
    submitted: submittedValue,
    probe: probe?.result?.result?.value,
  };
});

const now = new Date().toISOString();
const nextRuntime = {
  ...runtime,
  promptSubmitted: Boolean(result.submitted?.submitted),
  tabUrl: result.probe?.url || runtime.tabUrl,
  chromeHost: host,
  chromePort: Number(port) || port,
  chromeTargetId: tab.id,
};
const nextMeta = {
  ...meta,
  status: result.submitted?.submitted ? "running" : "error",
  browser: {
    ...meta.browser,
    runtime: nextRuntime,
  },
  response: result.submitted?.submitted ? { status: "running", incompleteReason: "manual-submit-recovery" } : { status: "error", incompleteReason: "not-submitted" },
  errorMessage: result.submitted?.submitted ? undefined : `Submit recovery failed: ${result.submitted?.reason ?? "unknown"}`,
  updatedAt: now,
  models: Array.isArray(meta.models)
    ? meta.models.map((model) => ({
        ...model,
        status: result.submitted?.submitted ? "running" : "error",
        response: result.submitted?.submitted ? { status: "running", incompleteReason: "manual-submit-recovery" } : { status: "error", incompleteReason: "not-submitted" },
      }))
    : meta.models,
};
fs.writeFileSync(metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`);
for (const model of nextMeta.models ?? []) {
  const sidecarPath = path.join(sessionDir, "models", `${model.model}.json`);
  if (!fs.existsSync(sidecarPath)) continue;
  const existing = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  fs.writeFileSync(sidecarPath, `${JSON.stringify({
    ...existing,
    status: result.submitted?.submitted ? "running" : "error",
    completedAt: result.submitted?.submitted ? undefined : now,
    response: result.submitted?.submitted
      ? { status: "running", incompleteReason: "manual-submit-recovery" }
      : { status: "error", incompleteReason: "not-submitted" },
    error: result.submitted?.submitted ? undefined : existing.error,
  }, null, 2)}\n`);
}
fs.writeFileSync(path.join(sessionDir, "live-state.json"), `${JSON.stringify({
  observedAt: now,
  generating: Boolean(result.probe?.generating),
  title: result.probe?.title,
  url: result.probe?.url,
  tabTitle: tab.title,
  tabUrl: tab.url,
  tabId: tab.id,
  port: String(port),
  session: sessionId,
  sessionStatus: nextMeta.status,
  length: result.probe?.textLength ?? 0,
  promptMatch: Boolean(result.probe?.promptMatch),
}, null, 2)}\n`);

console.log(JSON.stringify(result, null, 2));
