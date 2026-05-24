#!/usr/bin/env node
import { execFileSync } from "node:child_process";

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
const tailChars = Number(argValue("--tail", "40000"));
const jsonOnly = args.includes("--json");

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function discoverPorts() {
  if (explicitPort) return [explicitPort];
  const ports = [];
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

async function main() {
  const ports = discoverPorts();
  const attempts = [];
  for (const port of ports) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = tabs.find((tab) => {
        const haystack = `${tab.title ?? ""}\n${tab.url ?? ""}`;
        return haystack.toLowerCase().includes(titleFilter.toLowerCase()) ||
          haystack.toLowerCase().includes("chatgpt.com/c/");
      });
      if (!target?.webSocketDebuggerUrl) {
        attempts.push({ port, error: "no matching ChatGPT tab" });
        continue;
      }
      const value = await cdpEvaluate(target.webSocketDebuggerUrl, `(() => {
        const text = document.body.innerText || "";
        const generating = /\\b(Pro thinking|Finalizing answer|Thinking|Stop generating|I['’]m considering|I['’]m thinking|I also propose|I['’]ll|Still working|Working on)\\b/i.test(text);
        return {
          title: document.title,
          url: location.href,
          length: text.length,
          generating,
          text: text.slice(-${Math.max(1000, tailChars)})
        };
      })()`);
      const output = {
        port,
        tabTitle: target.title,
        tabUrl: target.url,
        ...value,
      };
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
  console.error(`No live ChatGPT tab could be read. Attempts: ${JSON.stringify(attempts)}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
