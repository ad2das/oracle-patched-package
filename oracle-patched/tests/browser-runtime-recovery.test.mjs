import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { performSessionRun } from "../dist/src/cli/sessionRunner.js";
import { setOracleHomeDirOverrideForTest } from "../dist/src/oracleHome.js";
import { sessionStore } from "../dist/src/sessionStore.js";

describe("browser runtime recovery metadata", () => {
    test("preserves the latest remote Chrome runtime after an attachment upload timeout", async (t) => {
        const oracleHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-recovery-"));
        setOracleHomeDirOverrideForTest(oracleHome);
        t.after(async () => {
            setOracleHomeDirOverrideForTest(null);
            await fs.rm(oracleHome, { recursive: true, force: true });
        });

        const prompt = "Review the prepared-reader bootstrap without changing renderer ownership.";
        const model = "gpt-5.6-sol-pro";
        const attachment = {
            path: path.join(oracleHome, "ReaderPreparedStore.kt"),
            displayPath: "app/src/main/java/reader/ReaderPreparedStore.kt",
            sizeBytes: 15_615,
        };
        const browserConfig = {
            attachRunning: true,
            remoteChrome: { host: "127.0.0.1", port: 62_649 },
            browserTabRef: "https://chatgpt.com/c/runtime-recovery-target",
        };
        const runOptions = {
            prompt,
            model,
            file: [attachment.path],
            silent: true,
            verbose: false,
        };
        const sessionMeta = await sessionStore.createSession(
            { prompt, model, mode: "browser", browserConfig },
            oracleHome,
            undefined,
            "browser-runtime-recovery",
        );

        assert.equal(sessionMeta.browser?.runtime, undefined, "the run-start snapshot must be stale");

        await assert.rejects(
            performSessionRun({
                sessionMeta,
                runOptions,
                mode: "browser",
                browserConfig,
                cwd: oracleHome,
                log: () => {},
                write: () => {},
                version: "test",
                browserDeps: {
                    assemblePrompt: async () => ({
                        composerText: prompt,
                        attachments: [attachment],
                        fallback: undefined,
                        attachmentMode: "upload",
                        attachmentsPolicy: "always",
                        bundled: null,
                        estimatedInputTokens: 64,
                    }),
                    executeBrowser: async (options) => {
                        await options.runtimeHintCb({
                            chromeHost: "127.0.0.1",
                            chromePort: 62_649,
                            chromeTargetId: "target-runtime-recovery",
                            tabUrl: "https://chatgpt.com/c/runtime-recovery-target",
                            conversationId: "runtime-recovery-target",
                            promptSubmitted: false,
                        });
                        throw new Error("Attachments did not finish uploading before timeout.");
                    },
                },
            }),
            /Attachments did not finish uploading before timeout/,
        );

        const stored = await sessionStore.readSession(sessionMeta.id);
        assert.ok(stored);
        assert.equal(stored.status, "error");
        assert.equal(stored.response?.incompleteReason, "not-submitted");
        assert.equal(stored.browser?.config?.remoteChrome?.port, 62_649);
        assert.deepEqual(
            stored.browser?.runtime,
            {
                chromeHost: "127.0.0.1",
                chromePort: 62_649,
                chromeTargetId: "target-runtime-recovery",
                tabUrl: "https://chatgpt.com/c/runtime-recovery-target",
                conversationId: "runtime-recovery-target",
                promptSubmitted: false,
                controllerPid: process.pid,
            },
            "the error handler must not overwrite the awaited runtime hint with stale session metadata",
        );
        assert.equal(stored.browser?.preparedSubmission?.prompt, prompt);
        assert.deepEqual(stored.browser?.preparedSubmission?.attachments, [attachment]);
        assert.equal(stored.options?.preparedSubmission?.prompt, prompt);
        assert.deepEqual(stored.options?.preparedSubmission?.attachments, [attachment]);

        const modelSidecarPath = path.join(
            oracleHome,
            "sessions",
            sessionMeta.id,
            "models",
            `${model}.json`,
        );
        const modelSidecar = JSON.parse(await fs.readFile(modelSidecarPath, "utf8"));
        assert.equal(modelSidecar.status, "error");
        assert.equal(modelSidecar.response?.incompleteReason, "not-submitted");
    });
});
