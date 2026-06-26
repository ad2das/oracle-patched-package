# Oracle Patched Package

This repository contains a patched copy of `@steipete/oracle` 0.12.1 under `oracle-patched/`.

Changes made:

- ChatGPT browser submissions with uploaded attachments use Enter instead of clicking the Send button.
- Attachment submissions skip the duplicate pre-send "clickable send button" readiness check, relying on the prior upload-completion step.
- Commit verification accepts attachment submissions when the composer clears and ChatGPT moves into conversation/response state.
- ChatGPT model selection accepts current visible labels such as `Instant`, `Thinking Heavy`, and `Thinking Extended` for GPT-5.2 browser runs.
- `read-live-chatgpt.mjs` records live ChatGPT state, and `run-oracle.mjs` blocks accidental duplicate browser submissions only when a current live read confirms ChatGPT is still generating.
- The wrapper ignores stale, unrelated, terminal, or unreadable live-state/session-log evidence instead of blocking new browser submissions on old `generating=true` records.
- When a browser run fails and live verification proves the prompt was not submitted, the wrapper automatically invokes `submit-live-chatgpt.mjs` once on the same session. If that recovery creates a ChatGPT conversation URL, the wrapper exits successfully so callers recover that session instead of starting a duplicate.
- Completed, errored, or cancelled sessions are excluded from that duplicate guard even if an older recovery state still says `generating=true`.
- `scripts/read-live-chatgpt.mjs` can inspect an existing ChatGPT browser tab by session, persist recovery state, and show the answer tail after a CLI disconnect.

Recovery policy:

- Do not treat `chrome-disconnected`, `Browser session ended`, `No live ChatGPT tab could be read`, or session `error` as final failure.
- First recover with `node scripts/run-oracle.mjs session <id> --render`.
- If the conversation is still live, inspect it with `node scripts/read-live-chatgpt.mjs --session <id> --tail 40000`.
- Start a duplicate browser run only when a current live read and automatic submit recovery cannot produce a submitted conversation, or when intentionally overridden with `ORACLE_ALLOW_BROWSER_DUPLICATE=1`.

Validation performed:

- Imported the patched `promptComposer.js` and `modelSelection.js` modules successfully with Node.
- Ran Oracle browser mode with `--browser-attachments always` against `gpt-5.2-instant`.
- Confirmed real uploaded attachment flow completed with answer `UPLOAD_OK`.
- Verified the duplicate-run guard refuses a new browser run when a recent log/live state indicates generation is still active.
- Recovered a `chrome-disconnected` browser session with `session <id> --render` and saved the transcript artifact before marking it completed.
