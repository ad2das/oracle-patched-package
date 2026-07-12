import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wrapper = join(scriptDir, "run-oracle.mjs");

test("oversized-file preflight failure never recovers an older completed session", () => {
  const root = mkdtempSync(join(tmpdir(), "oracle-wrapper-preflight-"));
  try {
    const oracleHome = join(root, "oracle-home");
    const oldSessionDir = join(oracleHome, "sessions", "old-completed");
    const transcript = join(oldSessionDir, "artifacts", "transcript.md");
    const oldPrompt = `${"You are the authoritative second-model reviewer. ".repeat(5)}Review the old files.`;
    const newPrompt = `${"You are the authoritative second-model reviewer. ".repeat(5)}Review the new files.`;
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(join(oldSessionDir, "meta.json"), JSON.stringify({
      mode: "browser",
      status: "completed",
      createdAt: "2020-01-01T00:00:00.000Z",
      options: { prompt: oldPrompt },
      promptPreview: oldPrompt.slice(0, 160),
      usage: { outputTokens: 100 },
    }));
    writeFileSync(transcript, "# Oracle transcript\n\n## Answer\n\nOLD_SESSION_SENTINEL\n");

    const oversizedFile = join(root, "oversized.txt");
    writeFileSync(oversizedFile, Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
    const oldMetaBefore = readFileSync(join(oldSessionDir, "meta.json"), "utf8");

    const result = spawnSync(process.execPath, [
      wrapper,
      "--engine", "browser",
      "--model", "gpt-5.6-sol-pro",
      "--prompt", newPrompt,
      "--file", oversizedFile,
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        ORACLE_HOME_DIR: oracleHome,
        ORACLE_ALLOW_BROWSER_DUPLICATE: "1",
        ORACLE_BROWSER_ALLOW_CLOSE: "1",
      },
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /exceed(?:s|ed)? (?:the )?(?:size limit|maximum file size)|too large|oversized/i);
    assert.match(output, /post-failure submission verification: .*"state":"unknown"/);
    assert.match(output, /no newly-created browser session matched the exact prompt fingerprint/);
    assert.doesNotMatch(output, /matched browser session completed/i);
    assert.doesNotMatch(output, /OLD_SESSION_SENTINEL/);
    assert.equal(readFileSync(join(oldSessionDir, "meta.json"), "utf8"), oldMetaBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
