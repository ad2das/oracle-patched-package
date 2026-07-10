import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    classifyObservedTabState,
    classifyTabState,
    isGenerationStatusTextForTest,
} from "../dist/src/browser/liveTabs.js";
import { deriveLiveTailState } from "../dist/src/cli/browserTabs.js";
import {
    isAnswerNowPlaceholderTextForTest,
    isAssistantGenerationStatusTextForTest,
} from "../dist/src/browser/actions/assistantResponse.js";
import { sanitizeThinkingText } from "../dist/src/browser/actions/thinkingStatus.js";

describe("live ChatGPT generation state", () => {
    test("keeps an unchanged Pro-thinking turn running while stop is visible", () => {
        const unchangedProThinking = {
            authenticated: true,
            stopExists: true,
            sendExists: false,
            assistantCount: 1,
            lastAssistantText: "Pro thinking Answer now",
            fingerprint: "unchanged-for-many-minutes",
            state: "stalled",
        };

        assert.equal(classifyTabState(unchangedProThinking), "running");
        assert.equal(
            classifyObservedTabState(unchangedProThinking, unchangedProThinking.fingerprint),
            "running",
        );
        assert.equal(deriveLiveTailState(unchangedProThinking), "running");
    });

    test("finishes only after the live stop signal disappears", () => {
        assert.equal(
            deriveLiveTailState({ authenticated: true, stopExists: false, assistantCount: 1 }),
            "completed",
        );
        assert.equal(
            deriveLiveTailState({ authenticated: false, stopExists: false, assistantCount: 0 }),
            "detached",
        );
    });

    test("keeps localized Pro generation chrome running without a stop button", () => {
        const localizedThinking = {
            authenticated: true,
            stopExists: false,
            thinkingStatusVisible: true,
            assistantCount: 1,
            lastAssistantText: "Pro 생각 중",
        };

        assert.equal(isGenerationStatusTextForTest("Pro 생각 중"), true);
        assert.equal(isAssistantGenerationStatusTextForTest("Pro 생각 중"), true);
        assert.equal(classifyTabState(localizedThinking), "running");
        assert.equal(deriveLiveTailState(localizedThinking), "running");
    });

    test("rejects Korean thinking and finalizing chrome as assistant answers", () => {
        for (const status of [
            "Pro 생각 중",
            "생각 중…",
            "답변 마무리 중",
            "응답을 마무리하는 중",
            "최종 답변 작성 중",
            "Finalizing answer",
        ]) {
            assert.equal(isGenerationStatusTextForTest(status), true, status);
            assert.equal(isAssistantGenerationStatusTextForTest(status), true, status);
            assert.equal(isAnswerNowPlaceholderTextForTest(status), true, status);
        }
        assert.equal(sanitizeThinkingText("Pro 생각 중"), "active");
    });

    test("does not treat an old localized phrase inside a real answer as live generation", () => {
        const completedAnswer = {
            authenticated: true,
            stopExists: false,
            thinkingStatusVisible: false,
            assistantCount: 2,
            lastAssistantText: "원인은 이전 turn의 ‘생각 중’ 문구가 본문 검색에 잡힌 것입니다.",
        };

        assert.equal(isGenerationStatusTextForTest(completedAnswer.lastAssistantText), false);
        assert.equal(isAssistantGenerationStatusTextForTest(completedAnswer.lastAssistantText), false);
        assert.equal(classifyTabState(completedAnswer), "completed");
        assert.equal(deriveLiveTailState(completedAnswer), "completed");
    });
});
