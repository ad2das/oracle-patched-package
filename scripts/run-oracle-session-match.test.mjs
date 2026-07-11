import assert from "node:assert/strict";
import test from "node:test";

import {
  matchNewBrowserSession,
  promptFingerprint,
} from "./run-oracle-session-match.mjs";

function browserSession(sessionId, prompt, status = "completed") {
  return {
    sessionId,
    sessionDir: `/sessions/${sessionId}`,
    mtimeMs: Date.now(),
    meta: {
      mode: "browser",
      status,
      options: { prompt },
      promptPreview: prompt.slice(0, 160),
    },
  };
}

test("preflight failure cannot recover a pre-existing completed session", () => {
  const old = browserSession("old-completed", "Review the current files");
  const matched = matchNewBrowserSession(
    [old],
    ["--engine", "browser", "-p", "Review the current files"],
    new Set([old.sessionId]),
  );

  assert.equal(matched, null);
});

test("new completed session with a different full prompt fingerprint is rejected", () => {
  const commonPrefix = "You are the authoritative second-model reviewer. ".repeat(5);
  const unrelated = browserSession("new-unrelated", `${commonPrefix}Review the old implementation.`);
  const matched = matchNewBrowserSession(
    [unrelated],
    ["--engine", "browser", "-p", `${commonPrefix}Review the new implementation.`],
    new Set(),
  );

  assert.equal(matched, null);
});

test("only one newly-created exact-prompt session is recoverable", () => {
  const prompt = "Review ReaderSession and propose the production-safe fix.";
  const oldExact = browserSession("old-exact", prompt);
  const newOther = browserSession("new-other", `${prompt} Different request.`);
  const newExact = browserSession("new-exact", `  Review ReaderSession\n and propose the production-safe fix.  `);
  const matched = matchNewBrowserSession(
    [newOther, oldExact, newExact],
    ["--engine=browser", `--prompt=${prompt}`],
    new Set([oldExact.sessionId]),
  );

  assert.equal(matched?.sessionId, newExact.sessionId);
  assert.equal(promptFingerprint(newExact.meta.options.prompt), promptFingerprint(prompt));
});

test("ambiguous same-prompt sessions are not guessed", () => {
  const prompt = "Audit the attached implementation.";
  const matched = matchNewBrowserSession(
    [browserSession("new-a", prompt), browserSession("new-b", prompt)],
    ["--engine", "browser", "--message", prompt],
    new Set(),
  );

  assert.equal(matched, null);
});

test("a truncated preview is not accepted as the fingerprint of a longer prompt", () => {
  const prompt = `${"shared prefix ".repeat(30)}new ending`;
  const previewOnly = browserSession("new-preview-only", prompt);
  delete previewOnly.meta.options.prompt;
  previewOnly.meta.promptPreview = prompt.slice(0, 160);

  const matched = matchNewBrowserSession(
    [previewOnly],
    ["--engine", "browser", "-p", prompt],
    new Set(),
  );

  assert.equal(matched, null);
});

test("a preview equal to a different request cannot override a mismatched full prompt", () => {
  const session = browserSession("new-prefix-collision", `${"same prefix ".repeat(30)}old ending`);
  const request = session.meta.promptPreview;

  const matched = matchNewBrowserSession(
    [session],
    ["--engine", "browser", "-p", request],
    new Set(),
  );

  assert.equal(matched, null);
});
