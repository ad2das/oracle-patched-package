import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    isGenerationStatusTextForTest,
    resolveSessionRuntimeForRecovery,
    selectSessionTargetForRecovery,
    sessionMatchEvidenceForTest,
} from "../../scripts/read-live-chatgpt.mjs";

describe("read-live ChatGPT session recovery", () => {
    test("prefers archived conversation URL when runtime regressed to ChatGPT root", () => {
        const runtime = resolveSessionRuntimeForRecovery({
            browser: {
                runtime: {
                    chromeTargetId: "stale-root-target",
                    tabUrl: "https://chatgpt.com/",
                    promptSubmitted: true,
                },
                archive: {
                    conversationUrl: "https://chatgpt.com/c/session-conversation-id",
                },
                config: { remoteChrome: { host: "127.0.0.1", port: 62649 } },
            },
        });

        assert.equal(runtime.tabUrl, "https://chatgpt.com/c/session-conversation-id");
        assert.equal(runtime.conversationId, "session-conversation-id");
        assert.equal(runtime.chromePort, 62649);
    });

    test("keeps an authoritative runtime conversation ahead of an older archive URL", () => {
        const runtime = resolveSessionRuntimeForRecovery({
            browser: {
                runtime: { tabUrl: "https://chatgpt.com/c/current-conversation" },
                archive: { conversationUrl: "https://chatgpt.com/c/older-conversation" },
            },
        });

        assert.equal(runtime.tabUrl, "https://chatgpt.com/c/current-conversation");
        assert.equal(runtime.conversationId, "current-conversation");
    });

    test("opens the preferred conversation instead of accepting a stale matching root target", () => {
        const runtime = {
            chromeTargetId: "stale-root-target",
            tabUrl: "https://chatgpt.com/c/session-conversation-id",
            conversationId: "session-conversation-id",
        };
        const rootTarget = {
            id: "stale-root-target",
            url: "https://chatgpt.com/",
            webSocketDebuggerUrl: "ws://root",
        };
        const conversationTarget = {
            id: "conversation-target",
            url: "https://chatgpt.com/c/session-conversation-id",
            webSocketDebuggerUrl: "ws://conversation",
        };

        assert.equal(selectSessionTargetForRecovery([rootTarget], runtime), null);
        assert.equal(
            selectSessionTargetForRecovery([rootTarget, conversationTarget], runtime),
            conversationTarget,
        );
    });

    test("does not session-match a stale root target when a conversation id is expected", () => {
        const runtime = {
            chromeTargetId: "stale-root-target",
            tabUrl: "https://chatgpt.com/c/session-conversation-id",
            conversationId: "session-conversation-id",
        };
        const stale = sessionMatchEvidenceForTest({
            target: { id: "stale-root-target", url: "https://chatgpt.com/" },
            value: { url: "https://chatgpt.com/", promptMatch: false },
            meta: {},
            runtime,
        });
        const recovered = sessionMatchEvidenceForTest({
            target: { id: "conversation-target", url: "https://chatgpt.com/c/session-conversation-id" },
            value: { url: "https://chatgpt.com/c/session-conversation-id", promptMatch: true },
            meta: {},
            runtime,
        });

        assert.equal(stale.matched, false);
        assert.equal(stale.reason, "expected-conversation-not-loaded");
        assert.equal(recovered.matched, true);
        assert.equal(recovered.reason, "conversationId");
    });

    test("scopes localized generation detection to concise live status text", () => {
        assert.equal(isGenerationStatusTextForTest("Pro 생각 중"), true);
        assert.equal(isGenerationStatusTextForTest("답변 마무리 중…"), true);
        assert.equal(
            isGenerationStatusTextForTest("사용자 프롬프트에 Pro 생각 중이라는 문구가 있었지만 응답은 끝났습니다."),
            false,
        );
    });

    test("falls back to a configured conversation only when runtime and archive lack one", () => {
        const runtime = resolveSessionRuntimeForRecovery({
            browser: {
                runtime: { tabUrl: "https://chatgpt.com/" },
                config: { browserTabRef: "https://chatgpt.com/c/config-conversation" },
            },
        });

        assert.equal(runtime.tabUrl, "https://chatgpt.com/c/config-conversation");
        assert.equal(runtime.conversationId, "config-conversation");
    });
});
