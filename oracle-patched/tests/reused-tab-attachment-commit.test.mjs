import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { __test__ as promptComposerTest } from "../dist/src/browser/actions/promptComposer.js";

const { verifyPromptCommitted } = promptComposerTest;

function reusedConversationState({ hasNewTurn, turnsCount }) {
    return {
        baseline: 4,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn,
        stopVisible: false,
        assistantVisible: true,
        composerCleared: true,
        inConversation: true,
        href: "https://chatgpt.com/c/existing-conversation",
        fallbackValue: "",
        editorValue: "",
        lastTurn: "An assistant response from before this Oracle run.",
        turnsCount,
    };
}

function runtimeReturning(state, calls) {
    return {
        async evaluate() {
            calls.count += 1;
            return { result: { value: state } };
        },
    };
}

async function withSingleFastPoll(operation) {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_000;
    Date.now = () => {
        const current = now;
        now += 10;
        return current;
    };
    globalThis.setTimeout = (callback, _delay, ...args) =>
        originalSetTimeout(callback, 0, ...args);
    try {
        return await operation();
    } finally {
        Date.now = originalNow;
        globalThis.setTimeout = originalSetTimeout;
    }
}

describe("attachment commit verification in a reused ChatGPT conversation", () => {
    test("rejects an unchanged old conversation even when the composer cleared and an attachment was present", async () => {
        const calls = { count: 0 };
        const runtime = runtimeReturning(
            reusedConversationState({ hasNewTurn: false, turnsCount: 4 }),
            calls,
        );

        await withSingleFastPoll(async () => {
            await assert.rejects(
                verifyPromptCommitted(
                    runtime,
                    "Current Oracle follow-up that was never added to the conversation",
                    15,
                    undefined,
                    4,
                    ["ReaderPreparedStore.kt"],
                ),
                /Prompt did not appear in conversation before timeout/,
            );
        });

        assert.equal(calls.count, 1, "the unchanged conversation should be evaluated once");
    });

    test("accepts the same reused conversation after its turn count advances", async () => {
        const calls = { count: 0 };
        const runtime = runtimeReturning(
            reusedConversationState({ hasNewTurn: true, turnsCount: 5 }),
            calls,
        );

        const committedTurns = await verifyPromptCommitted(
            runtime,
            "Current Oracle follow-up that was added to the conversation",
            1_000,
            undefined,
            4,
            ["ReaderPreparedStore.kt"],
        );

        assert.equal(committedTurns, 5);
        assert.equal(calls.count, 1);
    });
});
