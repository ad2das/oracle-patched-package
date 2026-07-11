import { createHash } from "node:crypto";

export function normalizePrompt(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export function promptForArgs(args) {
  return normalizePrompt(argValue(args, "--prompt") || argValue(args, "-p") || argValue(args, "--message"));
}

export function sessionPrompts(meta) {
  const values = [
    meta?.browser?.preparedSubmission?.prompt,
    meta?.options?.preparedSubmission?.prompt,
    meta?.options?.prompt,
    meta?.prompt,
  ];
  return [...new Set(values.map(normalizePrompt).filter(Boolean))];
}

export function sessionPrompt(meta) {
  return sessionPrompts(meta)[0] ?? normalizePrompt(meta?.promptPreview);
}

export function promptFingerprint(prompt) {
  const normalized = normalizePrompt(prompt);
  return normalized ? createHash("sha256").update(normalized, "utf8").digest("hex") : null;
}

export function matchNewBrowserSession(candidates, args, baselineSessionIds) {
  const requestedFingerprint = promptFingerprint(promptForArgs(args));
  if (!requestedFingerprint || !(baselineSessionIds instanceof Set)) return null;

  const matches = candidates.filter((candidate) => {
    if (!candidate?.sessionId || baselineSessionIds.has(candidate.sessionId)) return false;
    return sessionPrompts(candidate.meta).some(
      (prompt) => promptFingerprint(prompt) === requestedFingerprint,
    );
  });

  // Multiple new sessions with the same prompt are ambiguous (for example, a
  // concurrent duplicate invocation). Recovery must never guess which run owns
  // a completed answer.
  return matches.length === 1 ? matches[0] : null;
}
