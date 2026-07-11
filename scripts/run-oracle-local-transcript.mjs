import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { promptFingerprint } from "./run-oracle-session-match.mjs";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,199}$/i;
const MIN_FINAL_ANSWER_CHARS = 160;

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "chatgpt.com") return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function conversationIdFromUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const segments = new URL(normalized).pathname.split("/").filter(Boolean);
    const conversationIndex = segments.findIndex((segment) => segment === "c" || segment === "chat");
    return conversationIndex >= 0 ? segments[conversationIndex + 1] ?? null : null;
  } catch {
    return null;
  }
}

export function parseBrowserTranscript(contents) {
  const text = String(contents ?? "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("# Oracle Browser Transcript\n")) return null;
  const promptMarker = "\n## Prompt\n\n";
  const answerMarker = "\n## Answer\n\n";
  const promptMarkerIndex = text.indexOf(promptMarker);
  const answerMarkerIndex = text.indexOf(answerMarker, promptMarkerIndex + promptMarker.length);
  if (promptMarkerIndex < 0 || answerMarkerIndex < 0) return null;
  const header = text.slice(0, promptMarkerIndex);
  const conversationMatch = header.match(/(?:^|\n)Conversation:\s*(https:\/\/chatgpt\.com\/\S+)\s*$/im);
  const conversationUrl = normalizeUrl(conversationMatch?.[1]);
  const prompt = text
    .slice(promptMarkerIndex + promptMarker.length, answerMarkerIndex)
    .trim();
  const answer = text.slice(answerMarkerIndex + answerMarker.length).trim();
  if (!conversationUrl || !prompt || !answer) return null;
  return { conversationUrl, prompt, answer };
}

function isNonTinyFinalAnswer(answer) {
  const normalized = String(answer ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length < MIN_FINAL_ANSWER_CHARS) return false;
  return !/^(?:pro\s+thinking|thinking|finalizing answer|stop generating|called tool|used tool)[.!…\s]*$/i.test(normalized);
}

function hasOrderedCompletionLogEvidence(logText, sessionId) {
  const sessionLine = new RegExp(`(?:^|\\n)Session:\\s*${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\n|$)`);
  const archiveIndex = logText.lastIndexOf("[browser] Archived ChatGPT conversation after saving local artifacts.");
  const releaseIndex = logText.lastIndexOf("[browser] Released ChatGPT browser slot ");
  return sessionLine.test(logText) && archiveIndex >= 0 && releaseIndex > archiveIndex;
}

function browserIsUnreachable(runtime, deps) {
  const checks = [];
  for (const pid of [runtime?.controllerPid, runtime?.chromePid]) {
    const numericPid = Number(pid);
    if (Number.isInteger(numericPid) && numericPid > 0) {
      checks.push(!deps.isProcessAlive(numericPid));
    }
  }
  const numericPort = Number(runtime?.chromePort);
  const host = String(runtime?.chromeHost ?? "127.0.0.1").toLowerCase();
  if (Number.isInteger(numericPort) && numericPort > 0 && numericPort <= 65535) {
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    checks.push(!deps.isPortOpen(numericPort));
  }
  return checks.length > 0 && checks.every(Boolean);
}

function estimateTokenCount(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, Math.round(Math.max(words.length * 0.75, text.length / 4)));
}

function mergeTranscriptArtifact(existing, transcriptPath, transcriptStat, conversationUrl) {
  const transcript = {
    kind: "transcript",
    path: transcriptPath,
    label: "Browser transcript",
    mimeType: "text/markdown",
    sizeBytes: transcriptStat.size,
    sourceUrl: conversationUrl,
  };
  const values = (existing ?? []).filter(
    (artifact) => !(artifact?.kind === transcript.kind && artifact?.path === transcript.path),
  );
  return [...values, transcript];
}

export function recoverLocalCompletedTranscript({
  oracleHome,
  sessionId,
  isProcessAlive,
  isPortOpen,
  now = () => new Date(),
}) {
  if (!SESSION_ID_PATTERN.test(String(sessionId ?? ""))) {
    return { state: "not_applicable", reason: "unsafe-session-id" };
  }
  const sessionDir = join(oracleHome, "sessions", sessionId);
  const metaPath = join(sessionDir, "meta.json");
  const transcriptPath = join(sessionDir, "artifacts", "transcript.md");
  const logPath = join(sessionDir, "output.log");
  if (![metaPath, transcriptPath, logPath].every(existsSync)) {
    return { state: "not_applicable", reason: "missing-local-evidence" };
  }

  const meta = readJson(metaPath);
  const runtime = meta?.browser?.runtime;
  const preparedPrompt = meta?.browser?.preparedSubmission?.prompt;
  const priorRecovery = meta?.browser?.localArtifactRecovery;
  const isRunningCandidate =
    meta?.status === "running" &&
    Array.isArray(meta?.models) &&
    meta.models.length === 1 &&
    meta.models[0]?.status === "running";
  const isPreviouslyRecovered =
    meta?.status === "completed" &&
    meta?.response?.status === "completed" &&
    Array.isArray(meta?.models) &&
    meta.models.length === 1 &&
    meta.models[0]?.status === "completed" &&
    priorRecovery;
  if (
    meta?.id !== sessionId ||
    runtime?.promptSubmitted !== true ||
    typeof preparedPrompt !== "string" ||
    !preparedPrompt.trim() ||
    (!isRunningCandidate && !isPreviouslyRecovered)
  ) {
    return { state: "not_applicable", reason: "metadata-not-recoverable" };
  }

  const runtimeUrl = normalizeUrl(runtime.tabUrl);
  const runtimeConversationId = String(runtime.conversationId ?? "");
  if (
    !runtimeUrl ||
    !runtimeConversationId ||
    conversationIdFromUrl(runtimeUrl) !== runtimeConversationId
  ) {
    return { state: "not_applicable", reason: "runtime-conversation-mismatch" };
  }

  const liveState = readJson(join(sessionDir, "live-state.json"));
  const liveUrl = liveState?.url || liveState?.tabUrl;
  if (
    (liveState?.session && liveState.session !== sessionId) ||
    (liveUrl && conversationIdFromUrl(liveUrl) !== runtimeConversationId)
  ) {
    return { state: "not_applicable", reason: "live-state-session-mismatch" };
  }

  const transcript = parseBrowserTranscript(readFileSync(transcriptPath, "utf8"));
  if (!transcript) return { state: "not_applicable", reason: "invalid-transcript" };
  if (
    transcript.conversationUrl !== runtimeUrl ||
    conversationIdFromUrl(transcript.conversationUrl) !== runtimeConversationId
  ) {
    return { state: "not_applicable", reason: "transcript-conversation-mismatch" };
  }
  const requestedPromptFingerprint = promptFingerprint(preparedPrompt);
  if (
    !requestedPromptFingerprint ||
    promptFingerprint(transcript.prompt) !== requestedPromptFingerprint
  ) {
    return { state: "not_applicable", reason: "transcript-prompt-mismatch" };
  }
  if (!isNonTinyFinalAnswer(transcript.answer)) {
    return { state: "not_applicable", reason: "transcript-answer-not-final" };
  }

  const logText = readFileSync(logPath, "utf8").replace(/\r\n?/g, "\n");
  const transcriptStat = statSync(transcriptPath);
  const logStat = statSync(logPath);
  if (
    !hasOrderedCompletionLogEvidence(logText, sessionId) ||
    transcriptStat.mtimeMs > logStat.mtimeMs + 1_000
  ) {
    return { state: "not_applicable", reason: "completion-log-mismatch" };
  }
  if (isPreviouslyRecovered) {
    const expectedEvidence = ["prompt-fingerprint", "conversation-id", "archived", "lease-released", "browser-unreachable"];
    if (
      priorRecovery.transcriptPath !== transcriptPath ||
      priorRecovery.promptFingerprint !== requestedPromptFingerprint ||
      priorRecovery.conversationId !== runtimeConversationId ||
      !expectedEvidence.every((evidence) => priorRecovery.evidence?.includes(evidence))
    ) {
      return { state: "not_applicable", reason: "local-recovery-marker-mismatch" };
    }
    return {
      state: "rendered",
      sessionId,
      answer: transcript.answer,
      transcriptPath,
      completedAt: meta.completedAt,
    };
  }
  if (!browserIsUnreachable(runtime, { isProcessAlive, isPortOpen })) {
    return { state: "not_applicable", reason: "browser-still-reachable" };
  }

  const completedAt = now().toISOString();
  const outputTokens = estimateTokenCount(transcript.answer);
  const inputTokens = Math.max(0, Number(meta.browser.preparedSubmission.estimatedInputTokens) || 0);
  const usage = {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
  const nextMeta = {
    ...meta,
    mode: "browser",
    status: "completed",
    completedAt,
    updatedAt: completedAt,
    usage,
    answerChars: transcript.answer.length,
    options: {
      ...(meta.options ?? {}),
      prompt: preparedPrompt,
    },
    browser: {
      ...meta.browser,
      localArtifactRecovery: {
        recoveredAt: completedAt,
        transcriptPath,
        promptFingerprint: requestedPromptFingerprint,
        conversationId: runtimeConversationId,
        evidence: ["prompt-fingerprint", "conversation-id", "archived", "lease-released", "browser-unreachable"],
      },
    },
    response: { status: "completed" },
    models: meta.models.map((model) => ({
      ...model,
      status: "completed",
      completedAt,
      usage,
    })),
    artifacts: mergeTranscriptArtifact(meta.artifacts, transcriptPath, transcriptStat, runtimeUrl),
    errorMessage: undefined,
    error: undefined,
    transport: undefined,
  };
  writeFileSync(metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`, "utf8");
  return {
    state: "recovered",
    sessionId,
    answer: transcript.answer,
    transcriptPath,
    completedAt,
  };
}
