---
name: oracle
description: "Oracle second-model review using a bundled patched @steipete/oracle CLI. Use when Codex needs another model for code review, debugging, refactor advice, design checks, or large file-context analysis, including GPT-5.6 Sol/Terra/Luna in ChatGPT browser mode or the Responses API."
---

# Oracle Patched

Use this skill for Oracle second-model review with the bundled patched CLI in this skill repo.

Always invoke Oracle through the wrapper script relative to this `SKILL.md`:

```powershell
node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.6-sol-pro -p "<task>" --file "src/**"
```

On non-Windows shells, use the same script with forward slashes:

```bash
node "<skill-folder>/scripts/run-oracle.mjs" --engine browser --model gpt-5.6-sol-pro -p "<task>" --file "src/**"
```

Do not use `npx -y @steipete/oracle` for this skill. The wrapper runs the patched `oracle-patched/dist/bin/oracle-cli.js` bundled with this repo and installs runtime dependencies on first use if needed.

## GPT-5.6 Model Selection

- Browser: `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` select their matching visible ChatGPT tiers when the account exposes them.
- Browser: `gpt-5.6-<tier>-pro` selects the tier and then the separate ChatGPT `Pro` reasoning level. For example, `gpt-5.6-sol-pro` means **GPT-5.6 Sol + Pro effort**, not a nonexistent `GPT-5.6 Sol Pro` model slug.
- API: the same `*-pro` aliases dispatch the matching API model with `reasoning: { effort: "xhigh", mode: "pro" }`; the actual model IDs remain `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Do not silently fall back to GPT-5.5 if a requested GPT-5.6 tier is not visible. Use the picker error's available-options list to choose an exposed tier or ask the user.

## What Is Patched

- ChatGPT browser submissions with uploaded attachments use Enter instead of clicking the Send button.
- Attachment submissions skip the duplicate pre-send "clickable send button" readiness check after upload completion.
- Commit verification accepts uploaded-attachment submissions when the composer clears and ChatGPT moves into conversation or response state.
- Model selection accepts current ChatGPT labels such as `Instant`, `Thinking Heavy`, and `Thinking Extended` for GPT-5.2 browser runs.
- Model selection supports GPT-5.6 Sol, Terra, and Luna, and maps `gpt-5.6-<tier>-pro` to the tier plus ChatGPT's separate `Pro` reasoning level.
- Browser duplicate-run guard blocks a new browser submission only after a recent session or live recovery check confirms a currently readable ChatGPT tab is still generating.
- Browser duplicate-run guard ignores stale live-state and log evidence for sessions already marked `completed`, `error`, or `cancelled`.
- ChatGPT browser capture targets the latest assistant turn after the latest user prompt and waits for real completion controls before saving a transcript.
- Attachment upload readiness timeouts are treated as recoverable when file evidence is visible, because ChatGPT may already have accepted the files and started a response even if the CLI readiness check timed out.
- Live recovery preserves `generating=true` for errored sessions when a real `chatgpt.com/c/...` conversation is still generating, instead of clearing it just because the session metadata says `error`.
- Browser failures that verify as `not_submitted` automatically run `submit-live-chatgpt.mjs` once against the same session; if this creates a ChatGPT conversation, the wrapper exits successfully and instructs callers to recover that session instead of retrying.
- Browser sessions persist the fully assembled ChatGPT composer prompt before attachment upload begins, so a file-upload timeout can be live-submitted or retried without losing the prompt.
- Attachment readiness waits are capped by `ORACLE_ATTACHMENT_READY_TIMEOUT_MS` (default 120000 ms) instead of waiting many minutes with files attached and an empty composer.
- Browser failures that verify as `not_submitted` and cannot be live-submitted automatically retry the original Oracle CLI command once.
- Session-scoped live recovery rejects unrelated ChatGPT tabs unless they match the requested Oracle session by Chrome target id, conversation id/URL, persisted live-state URL, or the original prompt fingerprint.
- Submission verification treats session logs showing ChatGPT response activity (`ChatGPT thinking`, `status=active`, stop-generating/finalizing signals) as submitted evidence even when `promptSubmitted=false` or the conversation URL was not persisted before a disconnect.
- Browser failure recovery now matches the session for the current prompt/run instead of blindly using the newest browser session.
- If a matched browser session completed despite a CLI failure/interruption, the wrapper renders `session <id> --render` immediately to recover the answer.
- Long review-style browser runs that complete with a suspiciously tiny answer are rejected after rendering the transcript, so callers do not treat outputs like `I` as valid reviews.
- Suspiciously tiny review answers are also rejected when the browser answer was recovered from a live ChatGPT conversation or when a caller later runs `session <id> --render`; transcript answer length is checked when token usage is unavailable.
- Live ChatGPT recovery waits for conversation DOM content after reopening a saved session URL and reads current assistant turns from ChatGPT's role/markdown nodes, so loaded answers are not misclassified as missing when `article` elements are absent.
- Live session tailing treats a visible stop-generating control as authoritative generation evidence and never converts an unchanged Pro-thinking placeholder into `stalled` merely because its text fingerprint stayed constant.
- Browser recovery treats recent ChatGPT generation logs as submitted/recoverable even when Chrome or the DevTools port disappeared, because the server-side conversation may still be generating or may have completed after local Chrome disconnected.
- On Windows, browser launch reuses an already-running Oracle Chrome for the same profile instead of launching a duplicate process that immediately exits with `Opening in existing browser session`; launch handoff is recovered by rediscovering the real DevTools port.
- The wrapper defaults browser runs to `--browser-keep-browser` so Oracle does not close Chrome in `finally`; set `ORACLE_BROWSER_ALLOW_CLOSE=1` only when an intentional one-shot cleanup is desired.
- `--browser-attach-running --remote-chrome host:port` now falls back to probing `http://host:port/json/version` directly when local `DevToolsActivePort` metadata is missing, so a live Chrome DevTools port is not rejected merely because metadata discovery failed.

## Recommended Commands

- Help:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --help`

- Dry run:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --dry-run summary -p "<task>" --file "src/**"`

- Browser run:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.6-sol-pro -p "<task>" --file "src/**"`

- GPT-5.6 API run (requires API access):
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --engine api --model gpt-5.6-sol-pro -p "<task>" --file "src/**"`

- Force real uploaded attachments instead of inline text:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.6-sol-pro --browser-attachments always -p "<task>" --file "path/to/file.txt"`

- Reattach:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" session <id> --render`

- Status:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" status --hours 72`

- Recover a live ChatGPT browser tab after CLI disconnect:
  - `node "<skill-folder>\\scripts\\read-live-chatgpt.mjs" --session "<id>" --tail 40000`

- Submit/recover a browser session that attached files but never created a ChatGPT conversation:
  - `node "<skill-folder>\\scripts\\submit-live-chatgpt.mjs" --session "<id>"`

## Usage Notes

- Pick a tight file set and avoid secrets.
- Use `--browser-attachments always` when you need to prove real upload behavior.
- Browser runs can take a long time; if a run detaches or times out, reattach to the stored session instead of re-running.
- Do not treat `chrome-disconnected`, `Browser session ended`, `No live ChatGPT tab could be read`, or a session `error` status as proof that ChatGPT stopped generating or that no answer exists. If `read-live-chatgpt.mjs` has ever returned `generating=true` for the conversation, keep polling/recovering that same conversation until it returns `generating=false`, yields final answer text, or the user explicitly tells you to abandon it.
- Do not retry a failed browser request merely because the CLI printed `ECONNREFUSED`, `Browser session ended`, `No live ChatGPT tab could be read`, or returned a non-zero exit. First verify the latest browser session with actual evidence: `promptSubmitted=true`, a `chatgpt.com/c/...` URL, a live DOM read containing the submitted prompt/assistant response, or explicit `not-submitted` metadata. Retry only after this verification and the wrapper's automatic live-submit recovery both prove the prompt was not submitted. The wrapper prints a post-failure `submitted`, `not_submitted`, or `unknown` verification result for browser failures.
- If a session log already shows ChatGPT response activity, treat the request as submitted even if runtime metadata still says `promptSubmitted=false`; recover or poll that session instead of relaunching.
- Do not treat `Attachments did not finish uploading before timeout` as proof that the prompt was not submitted. First inspect the actual ChatGPT tab/conversation; files may be attached and the assistant may already be generating.
- If a browser run times out, disconnects, or reports `error`, first run `scripts/run-oracle.mjs session <id> --render`. This can reopen the saved ChatGPT conversation, save the transcript artifact, and mark the session completed.
- If the wrapper says a matched session completed, use the rendered answer it prints; do not start a duplicate run. If the wrapper rejects a suspiciously tiny completed answer, treat that session as invalid and rerun with a smaller prompt/file set.
- For browser review/check/audit prompts, rely on the latest assistant turn after the latest user prompt. If the transcript does not match the actual ChatGPT conversation, recover the same session with `session <id> --render` or `read-live-chatgpt.mjs --session <id>` and verify the page before using the artifact.
- First check whether the Oracle Chrome process still exists and has a `--remote-debugging-port`; if so, read the live ChatGPT tab with `scripts/read-live-chatgpt.mjs --session <id>`. Treat a failed session-scoped read as inconclusive; do not substitute a different visible ChatGPT tab unless it has explicit session evidence. If the recovered text still says `Pro thinking`, `Finalizing answer`, `Thinking`, or `Stop generating`, wait and poll the live tab instead of starting a new Oracle request.
- Prefer the live-tab recovery script over launching another Oracle run when the user can see Chrome still generating. Starting another run can duplicate requests and confuse which answer should be used.
- The wrapper refuses new browser runs only when a recent live state/session log can be verified against an open local Chrome debugging port and a currently readable ChatGPT conversation that is still generating. Terminal, stale, unrelated, or unreadable sessions are not treated as active just because an older recovery read once saw `generating=true`. Override only for an intentional duplicate by setting `ORACLE_ALLOW_BROWSER_DUPLICATE=1`.
- Treat Oracle output as advisory and verify against the repo and tests.
- When a GPT-5.6 `*-pro` browser run fails at the effort-selection step, do not submit at a lower effort; inspect the model picker and report the missing `Pro` level.
- If a session remains `running` but `runtime.promptSubmitted=false`, the URL is still `https://chatgpt.com/`, and live recovery shows `generating=false`, do not treat it as a valid in-progress answer. Use `submit-live-chatgpt.mjs --session <id>` to submit the existing composer, or let the wrapper reconcile it as `not-submitted` once the controller process is gone.
