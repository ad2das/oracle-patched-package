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

import { recoverLocalCompletedTranscript } from "./run-oracle-local-transcript.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wrapper = join(scriptDir, "run-oracle.mjs");
const sessionId = "local-final-session";
const conversationId = "6a52bff7-4f44-83e8-af79-4c7084314c6c";
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
const prompt = "Review this exact production implementation and give one decisive architecture plan.";
const answer = `${"This is the verified final architecture answer with concrete implementation detail. ".repeat(8)}Done.`;

function writeFixture(root, options = {}) {
  const oracleHome = join(root, "oracle-home");
  const fixtureSessionId = options.sessionId ?? sessionId;
  const sessionDir = join(oracleHome, "sessions", fixtureSessionId);
  const metaPath = join(sessionDir, "meta.json");
  const transcriptPath = join(sessionDir, "artifacts", "transcript.md");
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const runtimeUrl = options.runtimeUrl ?? conversationUrl;
  const runtimeConversationId = options.runtimeConversationId ?? conversationId;
  const preparedPrompt = options.preparedPrompt ?? prompt;
  const meta = {
    id: options.metaId ?? fixtureSessionId,
    status: "running",
    browser: {
      config: { desiredModel: "GPT-5.6 Sol", thinkingTime: "pro" },
      preparedSubmission: {
        prompt: preparedPrompt,
        estimatedInputTokens: 1234,
      },
      runtime: {
        controllerPid: options.controllerPid ?? 2_147_483_647,
        tabUrl: runtimeUrl,
        conversationId: runtimeConversationId,
        promptSubmitted: true,
      },
    },
    response: { status: "running", incompleteReason: "live-conversation-recovered" },
    models: [{
      model: "gpt-5.6-sol-pro",
      status: "running",
      startedAt: "2026-07-11T22:12:53.429Z",
      log: { path: "models/gpt-5.6-sol-pro.log" },
    }],
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(sessionDir, "live-state.json"), `${JSON.stringify({
    session: options.liveSessionId ?? fixtureSessionId,
    url: options.liveUrl ?? runtimeUrl,
    generating: true,
  }, null, 2)}\n`);
  writeFileSync(transcriptPath, [
    "# Oracle Browser Transcript",
    "",
    `Conversation: ${options.transcriptUrl ?? runtimeUrl}`,
    "",
    "## Prompt",
    "",
    options.transcriptPrompt ?? preparedPrompt,
    "",
    "## Answer",
    "",
    options.transcriptAnswer ?? answer,
    "",
  ].join("\n"));
  const archive = "[browser] Archived ChatGPT conversation after saving local artifacts.";
  const release = "[browser] Released ChatGPT browser slot abcdef12.";
  const evidence = options.reverseLogEvidence ? [release, archive] : [archive, release];
  writeFileSync(join(sessionDir, "output.log"), [
    `Session: ${fixtureSessionId}`,
    "Mode: browser foreground",
    ...(options.omitCompletionLog ? [] : evidence),
    "",
  ].join("\n"));
  return { oracleHome, sessionDir, metaPath, transcriptPath, fixtureSessionId };
}

function recover(fixture, overrides = {}) {
  return recoverLocalCompletedTranscript({
    oracleHome: fixture.oracleHome,
    sessionId: fixture.fixtureSessionId,
    isProcessAlive: overrides.isProcessAlive ?? (() => false),
    isPortOpen: overrides.isPortOpen ?? (() => false),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
  });
}

test("exact local final transcript reconciles running browser metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "oracle-local-final-"));
  try {
    const fixture = writeFixture(root);
    const result = recover(fixture);
    assert.equal(result.state, "recovered");
    assert.equal(result.answer, answer);

    const meta = JSON.parse(readFileSync(fixture.metaPath, "utf8"));
    assert.equal(meta.id, sessionId);
    assert.equal(meta.mode, "browser");
    assert.equal(meta.status, "completed");
    assert.equal(meta.response.status, "completed");
    assert.equal(meta.models[0].status, "completed");
    assert.equal(meta.options.prompt, prompt);
    assert.equal(meta.browser.localArtifactRecovery.conversationId, conversationId);
    assert.equal(meta.artifacts[0].path, fixture.transcriptPath);
    assert.ok(meta.usage.outputTokens > 0);

    const completedBefore = readFileSync(fixture.metaPath, "utf8");
    const rendered = recover(fixture, { isProcessAlive: () => true });
    assert.equal(rendered.state, "rendered");
    assert.equal(rendered.answer, answer);
    assert.equal(readFileSync(fixture.metaPath, "utf8"), completedBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local recovery rejects mismatched or incomplete evidence without mutation", async (t) => {
  const cases = [
    ["session id", { metaId: "other-session" }, {}, "metadata-not-recoverable"],
    ["prompt fingerprint", { transcriptPrompt: `${prompt} changed` }, {}, "transcript-prompt-mismatch"],
    ["conversation", { transcriptUrl: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111" }, {}, "transcript-conversation-mismatch"],
    ["live-state session", { liveSessionId: "other-session" }, {}, "live-state-session-mismatch"],
    ["tiny answer", { transcriptAnswer: "Done." }, {}, "transcript-answer-not-final"],
    ["completion log", { omitCompletionLog: true }, {}, "completion-log-mismatch"],
    ["log order", { reverseLogEvidence: true }, {}, "completion-log-mismatch"],
    ["live controller", {}, { isProcessAlive: () => true }, "browser-still-reachable"],
  ];

  for (const [name, fixtureOptions, deps, expectedReason] of cases) {
    await t.test(name, () => {
      const root = mkdtempSync(join(tmpdir(), "oracle-local-final-negative-"));
      try {
        const fixture = writeFixture(root, fixtureOptions);
        const before = readFileSync(fixture.metaPath, "utf8");
        const result = recover(fixture, deps);
        assert.equal(result.state, "not_applicable");
        assert.equal(result.reason, expectedReason);
        assert.equal(readFileSync(fixture.metaPath, "utf8"), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("wrapper renders a validated local final without invoking Chrome reattach", () => {
  const root = mkdtempSync(join(tmpdir(), "oracle-local-final-wrapper-"));
  try {
    const fixture = writeFixture(root);
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [wrapper, "session", sessionId, "--render"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ORACLE_HOME_DIR: fixture.oracleHome },
    });
    const elapsedMs = Date.now() - startedAt;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.ok(elapsedMs < 5_000, `local recovery took ${elapsedMs}ms`);
    assert.match(result.stdout, /verified final architecture answer/);
    assert.match(result.stderr, /Reconciled completed local browser transcript/);
    assert.doesNotMatch(output, /Attempting to reattach|Render will apply after completion/);
    assert.equal(JSON.parse(readFileSync(fixture.metaPath, "utf8")).status, "completed");

    const second = spawnSync(process.execPath, [wrapper, "session", sessionId, "--render"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, ORACLE_HOME_DIR: fixture.oracleHome },
    });
    const secondOutput = `${second.stdout ?? ""}\n${second.stderr ?? ""}`;
    assert.equal(second.status, 0, secondOutput);
    assert.match(second.stdout, /verified final architecture answer/);
    assert.match(second.stderr, /Rendered verified local browser transcript/);
    assert.doesNotMatch(secondOutput, /Attempting to reattach|Render will apply after completion/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
