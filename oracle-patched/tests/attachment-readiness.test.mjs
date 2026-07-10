import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    clearComposerAttachments,
    waitForAttachmentCompletion,
} from "../dist/src/browser/actions/attachments.js";
import { remoteChromeSharesLocalFilesForTest } from "../dist/src/browser/index.js";

function runtimeReturning(value, expressions = []) {
    return {
        async evaluate({ expression }) {
            expressions.push(expression);
            return { result: { value } };
        },
    };
}

describe("ChatGPT attachment readiness", () => {
    test("uses native CDP file input for loopback Chrome only", () => {
        assert.equal(remoteChromeSharesLocalFilesForTest("127.0.0.1"), true);
        assert.equal(remoteChromeSharesLocalFilesForTest("localhost"), true);
        assert.equal(remoteChromeSharesLocalFilesForTest("[::1]"), true);
        assert.equal(remoteChromeSharesLocalFilesForTest("192.0.2.10"), false);
    });

    test("accepts a localized structural file tile with ChatGPT's duplicate-name suffix", async () => {
        const expressions = [];
        const runtime = runtimeReturning(
            {
                state: "ready",
                uploading: false,
                filesAttached: true,
                attachedNames: ["ReaderPreparedStore(23).kt"],
                inputNames: ["ReaderPreparedStore.kt"],
                fileCount: 0,
            },
            expressions,
        );

        await waitForAttachmentCompletion(
            runtime,
            4_000,
            ["ReaderPreparedStore.kt"],
        );

        assert.ok(expressions.length >= 2, "readiness must remain stable before succeeding");
        assert.match(
            expressions[0],
            /\[role="group"\]\[class\*="file-tile"\]/,
            "the active composer must recognize language-independent structural file tiles",
        );
    });

    test("rejects input-only evidence when no attachment tile or count is anchored", async () => {
        const runtime = runtimeReturning({
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["ReaderPreparedStore.kt"],
            fileCount: 0,
        });

        await assert.rejects(
            waitForAttachmentCompletion(runtime, 1, ["ReaderPreparedStore.kt"]),
            /Attachments did not finish uploading before timeout/,
        );
    });

    test("cleanup targets the structural file-tile action without localized button text", async () => {
        const expressions = [];
        const states = [
            {
                removeClicks: 1,
                chipCount: 1,
                inputCount: 0,
                hadAttachments: true,
            },
            {
                removeClicks: 0,
                chipCount: 0,
                inputCount: 0,
                hadAttachments: false,
            },
        ];
        const runtime = {
            async evaluate({ expression }) {
                expressions.push(expression);
                return { result: { value: states.shift() ?? states.at(-1) } };
            },
        };

        await clearComposerAttachments(runtime, 1_000);

        assert.match(
            expressions[0],
            /\[role="group"\]\[class\*="file-tile"\] button\.behavior-btn/,
            "cleanup must not depend on an English Remove-file label",
        );
        assert.match(
            expressions[0],
            /const structuralTiles[\s\S]*Math\.max\(structuralTiles\.length, removeButtons\.length\)/,
            "cleanup must keep counting a structural tile even when its remove action is unavailable",
        );
        assert.equal(expressions.length, 2);
    });
});
