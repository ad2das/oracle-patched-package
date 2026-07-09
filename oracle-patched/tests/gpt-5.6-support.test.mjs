import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MODEL_CONFIGS, PRO_MODELS } from "../dist/src/oracle/config.js";
import { inferModelFromLabel, resolveApiModel } from "../dist/src/cli/options.js";
import { resolveRunOptionsFromConfig } from "../dist/src/cli/runOptions.js";
import { defaultBrowserThinkingTimeForModel, mapModelToBrowserLabel, } from "../dist/src/cli/browserConfig.js";
import { buildRequestBody } from "../dist/src/oracle/request.js";
import {
    assertResolvedModelSelectionForTest,
    buildComposerSignalMatchersForTest,
    buildModelMatchersLiteralForTest,
} from "../dist/src/browser/actions/modelSelection.js";
import { buildThinkingTimeExpressionForTest } from "../dist/src/browser/actions/thinkingTime.js";

const STANDARD_MODELS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const PRO_ALIASES = ["gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro"];

describe("GPT-5.6 model registry", () => {
    test("registers Sol, Terra, Luna, the official alias, and Pro mode aliases", () => {
        for (const model of [...STANDARD_MODELS, ...PRO_ALIASES]) {
            assert.ok(MODEL_CONFIGS[model], `${model} should be registered`);
            assert.equal(MODEL_CONFIGS[model].inputLimit, 1_050_000);
        }

        assert.equal(MODEL_CONFIGS["gpt-5.6"].apiModel, "gpt-5.6-sol");
        assert.equal(MODEL_CONFIGS["gpt-5.6-sol"].pricing.inputPerToken, 5 / 1_000_000);
        assert.equal(MODEL_CONFIGS["gpt-5.6-terra"].pricing.inputPerToken, 2.5 / 1_000_000);
        assert.equal(MODEL_CONFIGS["gpt-5.6-luna"].pricing.outputPerToken, 6 / 1_000_000);
    });

    test("maps Pro aliases to the real model id and Responses API Pro mode", () => {
        for (const alias of PRO_ALIASES) {
            const config = MODEL_CONFIGS[alias];
            assert.equal(config.apiModel, alias.replace(/-pro$/, ""));
            assert.deepEqual(config.reasoning, { effort: "xhigh", mode: "pro" });
            assert.ok(PRO_MODELS.has(alias));

            const body = buildRequestBody({
                modelConfig: config,
                systemPrompt: "system",
                userPrompt: "review this implementation",
                searchEnabled: false,
                background: true,
                storeResponse: true,
            });
            assert.equal(body.model, config.apiModel);
            assert.deepEqual(body.reasoning, { effort: "xhigh", mode: "pro" });
        }
    });
});

describe("GPT-5.6 CLI aliases", () => {
    test("resolves human-friendly labels without falling back to GPT-5.5", () => {
        const cases = new Map([
            ["5.6", "gpt-5.6"],
            ["GPT 5.6 Sol", "gpt-5.6-sol"],
            ["5.6 Sol Pro", "gpt-5.6-sol-pro"],
            ["GPT-5.6 Pro", "gpt-5.6-sol-pro"],
            ["5_6 Terra", "gpt-5.6-terra"],
            ["5.6 Terra Pro", "gpt-5.6-terra-pro"],
            ["5.6 Luna", "gpt-5.6-luna"],
            ["5.6 Luna Pro", "gpt-5.6-luna-pro"],
        ]);

        for (const [input, expected] of cases) {
            assert.equal(resolveApiModel(input), expected);
            assert.equal(inferModelFromLabel(input), expected);
        }
    });

    test("resolves Sol Pro to the real API model id", () => {
        const result = resolveRunOptionsFromConfig({
            prompt: "review this implementation",
            model: "5.6 Sol Pro",
            engine: "api",
            userConfig: {},
            env: {},
        });

        assert.equal(result.resolvedEngine, "api");
        assert.equal(result.runOptions.model, "gpt-5.6-sol-pro");
        assert.equal(result.runOptions.effectiveModelId, "gpt-5.6-sol");
        assert.equal(result.engineCoercedToApi, false);
    });

    test("supports every GPT-5.6 model in explicit ChatGPT browser mode", () => {
        const expectedLabels = new Map([
            ["gpt-5.6", "GPT-5.6 Sol"],
            ["gpt-5.6-sol", "GPT-5.6 Sol"],
            ["gpt-5.6-terra", "GPT-5.6 Terra"],
            ["gpt-5.6-luna", "GPT-5.6 Luna"],
            ["gpt-5.6-sol-pro", "GPT-5.6 Sol"],
            ["gpt-5.6-terra-pro", "GPT-5.6 Terra"],
            ["gpt-5.6-luna-pro", "GPT-5.6 Luna"],
        ]);

        for (const [model, expectedLabel] of expectedLabels) {
            const result = resolveRunOptionsFromConfig({
                prompt: "review this implementation",
                model,
                engine: "browser",
                userConfig: {},
                env: {},
            });
            assert.equal(result.resolvedEngine, "browser");
            assert.equal(result.runOptions.model, model.replace(/-pro$/, ""));
            assert.equal(mapModelToBrowserLabel(model), expectedLabel);
        }
    });

    test("builds tier-specific ChatGPT picker and composer matchers", () => {
        const matchers = buildModelMatchersLiteralForTest("GPT-5.6 Sol Pro");
        assert.ok(matchers.labelTokens.includes("5.6 sol"));
        assert.ok(matchers.testIdTokens.includes("model-switcher-gpt-5-6-sol-pro"));
        assert.deepEqual(buildComposerSignalMatchersForTest("GPT-5.6 Sol Pro"), {
            includesAny: ["sol pro"],
            excludesAny: ["thinking", "terra", "luna"],
            allowBlank: false,
        });

        assert.doesNotThrow(() => assertResolvedModelSelectionForTest("GPT-5.6 Sol Pro", "GPT-5.6 Sol Pro"));
        assert.throws(() => assertResolvedModelSelectionForTest("GPT-5.6 Sol Pro", "GPT-5.6 Terra Pro"), /requires GPT-5\.6 sol Pro/);
        assert.throws(() => assertResolvedModelSelectionForTest("GPT-5.6 Sol Pro", "GPT-5.6 Sol"), /requires GPT-5\.6 sol Pro/);
    });

    test("maps a GPT-5.6 Pro alias to the separate browser Pro effort", () => {
        assert.equal(defaultBrowserThinkingTimeForModel("gpt-5.6-sol-pro"), "pro");
        assert.equal(defaultBrowserThinkingTimeForModel("5.6 Terra Pro"), "pro");
        assert.equal(defaultBrowserThinkingTimeForModel("gpt-5.6-sol"), undefined);
        assert.equal(mapModelToBrowserLabel("gpt-5.6-pro"), "GPT-5.6 Sol");

        const expression = buildThinkingTimeExpressionForTest("pro", "GPT-5.6 Sol");
        assert.match(expression, /pro: \['pro'\]/);
        assert.match(expression, /directEffortOption/);
    });
});
