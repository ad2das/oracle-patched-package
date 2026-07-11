import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveExactChatGptTargetForTest } from "../dist/src/browser/liveTabs.js";

const targets = [
    {
        id: "slow-unrelated-target",
        type: "page",
        title: "Large unrelated conversation",
        url: "https://chatgpt.com/c/unrelated",
    },
    {
        id: "requested-target",
        type: "page",
        title: "Requested conversation",
        url: "https://chatgpt.com/c/requested",
    },
];

describe("exact ChatGPT tab resolution", () => {
    test("resolves a full conversation URL from raw targets without DOM inspection", () => {
        assert.deepEqual(
            resolveExactChatGptTargetForTest(
                targets,
                "https://chatgpt.com/c/requested",
                "127.0.0.1",
                62649,
            ),
            {
                host: "127.0.0.1",
                port: 62649,
                targetId: "requested-target",
                title: "Requested conversation",
                url: "https://chatgpt.com/c/requested",
            },
        );
    });

    test("resolves an exact target id and leaves title/current matching to inspected summaries", () => {
        assert.equal(
            resolveExactChatGptTargetForTest(targets, "requested-target")?.url,
            "https://chatgpt.com/c/requested",
        );
        assert.equal(resolveExactChatGptTargetForTest(targets, "Requested conversation"), null);
        assert.equal(resolveExactChatGptTargetForTest(targets, "current"), null);
    });
});
