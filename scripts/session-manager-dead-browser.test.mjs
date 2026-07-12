import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("dead recovered browser becomes reattachable chrome-disconnected state", async () => {
  const root = mkdtempSync(join(tmpdir(), "oracle-dead-browser-"));
  const oracleHome = join(root, "oracle-home");
  const sessionId = "dead-recovered-browser";
  const sessionDir = join(oracleHome, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });

  try {
    process.env.ORACLE_HOME_DIR = oracleHome;
    writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify({
      id: sessionId,
      mode: "browser",
      status: "running",
      createdAt: new Date().toISOString(),
      browser: {
        runtime: {
          chromePid: 2_147_483_647,
          promptSubmitted: true,
          conversationId: "6a52da51-d150-83e8-8a60-4fef25950a2d",
          tabUrl: "https://chatgpt.com/c/6a52da51-d150-83e8-8a60-4fef25950a2d",
        },
      },
      response: {
        status: "running",
        incompleteReason: "live-conversation-recovered",
      },
    }, null, 2)}\n`);

    const moduleUrl = new URL("../oracle-patched/dist/src/sessionManager.js", import.meta.url);
    const { readSessionMetadata } = await import(`${moduleUrl.href}?test=${Date.now()}`);
    const metadata = await readSessionMetadata(sessionId);

    assert.equal(metadata.status, "error");
    assert.equal(metadata.errorMessage, "Browser session ended (Chrome is no longer reachable)");
    assert.equal(metadata.response.status, "error");
    assert.equal(metadata.response.incompleteReason, "chrome-disconnected");
    assert.equal(metadata.browser.runtime.conversationId, "6a52da51-d150-83e8-8a60-4fef25950a2d");
  } finally {
    delete process.env.ORACLE_HOME_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});
