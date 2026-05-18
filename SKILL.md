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

## Usage Notes

- Pick a tight file set and avoid secrets.
- Use `--browser-attachments always` when you need to prove real upload behavior.
- Browser runs can take a long time; if a run detaches or times out, reattach to the stored session instead of re-running.
- Treat Oracle output as advisory and verify against the repo and tests.
