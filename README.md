# Oracle Patched Package

This repository contains a patched copy of `@steipete/oracle` 0.12.1 under `oracle-patched/`.

Changes made:

- ChatGPT browser submissions with uploaded attachments use Enter instead of clicking the Send button.
- Attachment submissions skip the duplicate pre-send "clickable send button" readiness check, relying on the prior upload-completion step.
- Commit verification accepts attachment submissions when the composer clears and ChatGPT moves into conversation/response state.
- ChatGPT model selection accepts current visible labels such as `Instant`, `Thinking Heavy`, and `Thinking Extended` for GPT-5.2 browser runs.

Validation performed:

- Imported the patched `promptComposer.js` and `modelSelection.js` modules successfully with Node.
- Ran Oracle browser mode with `--browser-attachments always` against `gpt-5.2-instant`.
- Confirmed real uploaded attachment flow completed with answer `UPLOAD_OK`.
