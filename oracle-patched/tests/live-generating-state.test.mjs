import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyObservedTabState, classifyTabState } from "../dist/src/browser/liveTabs.js";
import { deriveLiveTailState } from "../dist/src/cli/browserTabs.js";

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
});
