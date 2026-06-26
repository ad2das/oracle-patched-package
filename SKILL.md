---
name: oracle
description: "Oracle second-model review using a bundled patched @steipete/oracle browser CLI. Use when Codex needs to ask another model for code review, debugging, refactor advice, design checks, or large file-context analysis, especially with ChatGPT browser mode and uploaded attachments that must submit via Enter instead of clicking Send."
---

# Oracle Patched

Use this skill for Oracle second-model review with the bundled patched CLI in this skill repo.

Always invoke Oracle through the wrapper script relative to this `SKILL.md`:

```powershell
node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.5-pro -p "<task>" --file "src/**"
```

On non-Windows shells, use the same script with forward slashes:

```bash
node "<skill-folder>/scripts/run-oracle.mjs" --engine browser --model gpt-5.5-pro -p "<task>" --file "src/**"
```

Do not use `npx -y @steipete/oracle` for this skill. The wrapper runs the patched `oracle-patched/dist/bin/oracle-cli.js` bundled with this repo and installs runtime dependencies on first use if needed.

## What Is Patched

- ChatGPT browser submissions with uploaded attachments use Enter instead of clicking the Send button.
- Attachment submissions skip the duplicate pre-send "clickable send button" readiness check after upload completion.
- Commit verification accepts uploaded-attachment submissions when the composer clears and ChatGPT moves into conversation or response state.
- Model selection accepts current ChatGPT labels such as `Instant`, `Thinking Heavy`, and `Thinking Extended` for GPT-5.2 browser runs.
- Browser duplicate-run guard blocks a new browser submission when a recent session or live recovery check indicates ChatGPT may still be generating.
- Browser duplicate-run guard ignores stale live-state and log evidence for sessions already marked `completed`, `error`, or `cancelled`.
- ChatGPT browser capture targets the latest assistant turn after the latest user prompt and waits for real completion controls before saving a transcript.
- Attachment upload readiness timeouts are treated as recoverable when file evidence is visible, because ChatGPT may already have accepted the files and started a response even if the CLI readiness check timed out.
- Live recovery preserves `generating=true` for errored sessions when a real `chatgpt.com/c/...` conversation is still generating, instead of clearing it just because the session metadata says `error`.

## Recommended Commands

- Help:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --help`

- Dry run:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --dry-run summary -p "<task>" --file "src/**"`

- Browser run:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.5-pro -p "<task>" --file "src/**"`

- Force real uploaded attachments instead of inline text:
  - `node "<skill-folder>\\scripts\\run-oracle.mjs" --engine browser --model gpt-5.2-instant --browser-attachments always -p "<task>" --file "path/to/file.txt"`

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
- Do not retry a failed browser request merely because the CLI printed `ECONNREFUSED`, `Browser session ended`, `No live ChatGPT tab could be read`, or returned a non-zero exit. First verify the latest browser session with actual evidence: `promptSubmitted=true`, a `chatgpt.com/c/...` URL, a live DOM read containing the submitted prompt/assistant response, or explicit `not-submitted` metadata. Retry only after this verification proves the prompt was not submitted. The wrapper prints a post-failure `submitted`, `not_submitted`, or `unknown` verification result for browser failures.
- Do not treat `Attachments did not finish uploading before timeout` as proof that the prompt was not submitted. First inspect the actual ChatGPT tab/conversation; files may be attached and the assistant may already be generating.
- If a browser run times out, disconnects, or reports `error`, first run `scripts/run-oracle.mjs session <id> --render`. This can reopen the saved ChatGPT conversation, save the transcript artifact, and mark the session completed.
- For browser review/check/audit prompts, rely on the latest assistant turn after the latest user prompt. If the transcript does not match the actual ChatGPT conversation, recover the same session with `session <id> --render` or `read-live-chatgpt.mjs --session <id>` and verify the page before using the artifact.
- First check whether the Oracle Chrome process still exists and has a `--remote-debugging-port`; if so, read the live ChatGPT tab with `scripts/read-live-chatgpt.mjs`. If the recovered text still says `Pro thinking`, `Finalizing answer`, `Thinking`, or `Stop generating`, wait and poll the live tab instead of starting a new Oracle request.
- Prefer the live-tab recovery script over launching another Oracle run when the user can see Chrome still generating. Starting another run can duplicate requests and confuse which answer should be used.
- The wrapper refuses new browser runs when a recent live state/session log suggests generation may still be active, but terminal sessions are not treated as active just because an older recovery read once saw `generating=true`. Override only for an intentional duplicate by setting `ORACLE_ALLOW_BROWSER_DUPLICATE=1`.
- Treat Oracle output as advisory and verify against the repo and tests.
- If a session remains `running` but `runtime.promptSubmitted=false`, the URL is still `https://chatgpt.com/`, and live recovery shows `generating=false`, do not treat it as a valid in-progress answer. Use `submit-live-chatgpt.mjs --session <id>` to submit the existing composer, or let the wrapper reconcile it as `not-submitted` once the controller process is gone.
