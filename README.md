# Oracle Patched Package

This repository contains a patched copy of `@steipete/oracle` 0.12.1 under `oracle-patched/`.

Changes made:

- ChatGPT browser submissions with uploaded attachments use Enter instead of clicking the Send button.
- Attachment submissions skip the duplicate pre-send "clickable send button" readiness check, relying on the prior upload-completion step.
- Commit verification accepts attachment submissions when the composer clears and ChatGPT moves into conversation/response state.
- ChatGPT model selection accepts current visible labels such as `Instant`, `Thinking Heavy`, and `Thinking Extended` for GPT-5.2 browser runs.
- `read-live-chatgpt.mjs` records live ChatGPT state, and `run-oracle.mjs` blocks accidental duplicate browser submissions when a recent session may still be generating.
- The wrapper blocks duplicate browser submissions when a recent live-state or session log indicates ChatGPT may still be generating.
- Completed, errored, or cancelled sessions are excluded from that duplicate guard even if an older recovery state still says `generating=true`.
- `scripts/read-live-chatgpt.mjs` can inspect an existing ChatGPT browser tab by session, persist recovery state, and show the answer tail after a CLI disconnect.

Recovery policy:

- Do not treat `chrome-disconnected`, `Browser session ended`, `No live ChatGPT tab could be read`, or session `error` as final failure.
- First recover with `node scripts/run-oracle.mjs session <id> --render`.
- If the conversation is still live, inspect it with `node scripts/read-live-chatgpt.mjs --session <id> --tail 40000`.
- Start a duplicate browser run only when recovery is impossible or intentionally overridden with `ORACLE_ALLOW_BROWSER_DUPLICATE=1`.

Validation performed:

- Imported the patched `promptComposer.js` and `modelSelection.js` modules successfully with Node.
- Ran Oracle browser mode with `--browser-attachments always` against `gpt-5.2-instant`.
- Confirmed real uploaded attachment flow completed with answer `UPLOAD_OK`.
- Verified the duplicate-run guard refuses a new browser run when a recent log/live state indicates generation is still active.
- Recovered a `chrome-disconnected` browser session with `session <id> --render` and saved the transcript artifact before marking it completed.
