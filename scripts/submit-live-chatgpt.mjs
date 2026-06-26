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
const preparedSubmission = meta.browser?.preparedSubmission ?? meta.options?.preparedSubmission ?? {};
const prompt = preparedSubmission.prompt || meta.options?.prompt || "";
const port = runtime.chromePort;

if (!port || !prompt) {
  console.error(`Session has no Chrome port or prompt to submit. port=${Boolean(port)} prompt=${Boolean(prompt)}`);
  process.exit(2);
}

async function listTabs() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools list failed: HTTP ${response.status}`);
  return response.json();
}

function scoreTab(tab) {
  let score = 0;
  if (runtime.chromeTargetId && tab.id === runtime.chromeTargetId) score += 1000;
  if (tab.url === runtime.tabUrl) score += 500;
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
        node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: prompt, inputType: 'insertFromPaste' }));
      } catch {}
      try {
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertFromPaste' }));
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

function probeExpression() {
  return `(() => {
    const text = document.body.innerText || '';
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .map((node) => [node.getAttribute('aria-label'), node.textContent].filter(Boolean).join(' '));
    return {
      url: location.href,
      title: document.title,
      generating: buttons.some((label) => /stop generating|stop answering|생성 중지|중지/i.test(label)) || /thinking|finalizing answer|응답 생성|생각 중/i.test(text),
      textLength: text.length,
    };
  })()`;
}

const tabs = await listTabs();
const tab = tabs
  .filter((item) => item.webSocketDebuggerUrl)
  .map((item) => ({ item, score: scoreTab(item) }))
  .sort((a, b) => b.score - a.score)[0]?.item;

if (!tab) {
  console.error("No ChatGPT DevTools tab found for session.");
  process.exit(1);
}

const result = await withCdp(tab.webSocketDebuggerUrl, async (send) => {
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
      const clicked = await send("Runtime.evaluate", {
        expression: sendExpression(),
        returnByValue: true,
        awaitPromise: true,
      });
      submittedValue = clicked.result?.result?.value;
      if (!submittedValue?.submitted) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        submittedValue = { submitted: true, method: "cdp-enter", url: composer.result?.result?.value?.url };
      }
    }
  }
  let probe = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    probe = await send("Runtime.evaluate", {
      expression: probeExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = probe.result?.result?.value;
    if (!submittedValue?.submitted || /chatgpt\.com\/(?:g\/[^/]+\/)?(?:c\/|chat\/)/i.test(String(value?.url ?? "")) || value?.generating) {
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
};
const nextMeta = {
  ...meta,
  status: result.submitted?.submitted ? "running" : "error",
  browser: {
    ...meta.browser,
    runtime: nextRuntime,
  },
  response: result.submitted?.submitted ? { status: "running", incompleteReason: "manual-submit-recovery" } : { status: "error", incompleteReason: "not-submitted" },
  errorMessage: result.submitted?.submitted ? meta.errorMessage : `Submit recovery failed: ${result.submitted?.reason ?? "unknown"}`,
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
}, null, 2)}\n`);

console.log(JSON.stringify(result, null, 2));
