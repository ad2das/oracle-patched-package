import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DEFAULT_MODEL, MODEL_CONFIGS, PRO_MODELS } from "../dist/src/oracle/config.js";
import { inferModelFromLabel, resolveApiModel } from "../dist/src/cli/options.js";
import { buildBrowserConfig, defaultBrowserThinkingTimeForModel, mapModelToBrowserLabel } from "../dist/src/cli/browserConfig.js";
import { resolveRunOptionsFromConfig } from "../dist/src/cli/runOptions.js";
import { buildRequestBody } from "../dist/src/oracle/request.js";
import { buildModelSelectionExpressionForTest, ensureModelSelection } from "../dist/src/browser/actions/modelSelection.js";
import { isGpt6ModelLabel } from "../dist/src/browser/actions/gpt6ModelSelection.js";
import { buildThinkingTimeExpressionForTest } from "../dist/src/browser/actions/thinkingTime.js";
import { MODEL_BUTTON_SELECTOR } from "../dist/src/browser/constants.js";
import { verifyRecoveryModel } from "../../scripts/verify-browser-model.mjs";

test("GPT-6 Pro defaults to the real Astra API model with maximum Pro reasoning", () => {
    assert.equal(DEFAULT_MODEL, "gpt-6-astra-pro");
    assert.ok(PRO_MODELS.has(DEFAULT_MODEL));
    const modelConfig = MODEL_CONFIGS[DEFAULT_MODEL];
    assert.equal(modelConfig.inputLimit, 922_000);
    const body = buildRequestBody({ modelConfig, systemPrompt: "system", userPrompt: "test", searchEnabled: false });
    assert.equal(body.model, "gpt-6-astra");
    assert.deepEqual(body.reasoning, { effort: "max", mode: "pro" });
});

test("GPT-6 spellings never resolve to an older model", () => {
    for (const alias of ["gpt-6-pro", "GPT6 Pro", "GPT 6 Pro", "6 Pro", "gpt-6-astra-pro", "GPT-6 Astra Pro"]) {
        assert.equal(resolveApiModel(alias), "gpt-6-astra-pro", alias);
        assert.equal(inferModelFromLabel(alias), "gpt-6-astra-pro", alias);
        const result = resolveRunOptionsFromConfig({ prompt: "test", model: alias, engine: "browser", userConfig: {}, env: {} });
        assert.equal(result.resolvedEngine, "browser");
        assert.equal(result.runOptions.model, "gpt-6-astra-pro");
        assert.equal(result.runOptions.effectiveModelId, "gpt-6-astra");
    }
    for (const alias of ["gpt-6", "GPT6", "GPT-6 Astra"]) {
        assert.equal(resolveApiModel(alias), "gpt-6-astra");
    }
});

test("browser configuration separates model identity from mandatory Pro effort", async () => {
    assert.equal(mapModelToBrowserLabel("gpt-6-pro"), "GPT-6 Astra");
    assert.equal(defaultBrowserThinkingTimeForModel("gpt-6-astra-pro"), "pro");
    assert.equal(defaultBrowserThinkingTimeForModel("gpt-6-astra"), undefined);
    const config = await buildBrowserConfig({ model: "gpt-6-astra-pro" });
    assert.equal(config.desiredModel, "GPT-6 Astra");
    assert.equal(config.thinkingTime, "pro");
    await assert.rejects(buildBrowserConfig({ model: "gpt-6-astra-pro", browserThinkingTime: "heavy" }), /requires Pro/);
    await assert.rejects(buildBrowserConfig({ model: "gpt-6-astra-pro", browserModelStrategy: "current" }), /verified model selection/);
});

test("model evidence requires GPT-6 rather than bare Pro or an unverified Latest row", async () => {
    for (const label of ["6 Pro", "6Pro", "6", "GPT-6 Astra", "GPT-6 Astra Pro", "6 High"]) {
        assert.equal(isGpt6ModelLabel(label), true, label);
    }
    for (const label of ["GPT-5.6 Sol Pro", "GPT-5.5 Pro", "Latest", "최신", "Pro", "7 Pro", "6.1 Pro", "16 Pro", "", null, undefined]) {
        assert.equal(isGpt6ModelLabel(label), false, label);
        await assert.rejects(ensureModelSelection({ evaluate: async () => ({ result: { value: { status: "switched", label } } }) }, "GPT-6 Astra", () => {}), /requires verified GPT-6/);
    }
    await assert.rejects(ensureModelSelection({}, "GPT-6 Astra", () => {}, "current"), /bypass/);
});

class UiEvent extends Event {
    constructor(type, options = {}) {
        super(type, options);
        this.key = options.key;
    }
}

class UiNode extends EventTarget {
    constructor(text = "", attributes = {}) {
        super();
        this.textContent = text;
        this.attributes = attributes;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return { width: 200, height: 30 }; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
}

function domContext(document) {
    let clock = 0;
    return {
        document,
        EventTarget,
        HTMLElement: UiNode,
        Event: UiEvent,
        MouseEvent: UiEvent,
        KeyboardEvent: UiEvent,
        window: {},
        performance: { now: () => clock },
        setTimeout: (callback, milliseconds) => { clock += milliseconds; callback(); },
    };
}

function modelFixture({ initial = "GPT-5.6 Sol", target = "6 High", choices = ["최신", "GPT-5.6 Sol", "GPT-5.5"] } = {}) {
    let open = false;
    let advanced = false;
    const clicks = [];
    const button = new UiNode(initial, { "aria-controls": "picker" });
    button.getAttribute = name => name === "aria-expanded" ? String(open) : button.attributes[name] ?? null;
    const toggle = new UiNode(initial);
    toggle.getAttribute = name => name === "aria-expanded" ? String(advanced) : null;
    const surface = new UiNode();
    const rows = choices.map(label => {
        const row = new UiNode(label);
        row.closest = () => !open || !advanced ? surface : null;
        row.addEventListener("click", () => { clicks.push(label); button.textContent = target; toggle.textContent = target; open = false; });
        return row;
    });
    toggle.closest = () => !open ? surface : null;
    button.addEventListener("click", () => { open = !open; });
    toggle.addEventListener("click", () => { advanced = !advanced; });
    surface.querySelectorAll = selector => selector.includes("menuitemradio") ? rows : open ? [toggle] : [];
    const document = {
        getElementById: () => open ? surface : null,
        querySelector: selector => selector === MODEL_BUTTON_SELECTOR ? button : open ? surface : null,
        dispatchEvent: event => { if (event.key === "Escape") open = false; },
    };
    return { context: domContext(document), clicks };
}

test("current numeric GPT-6 badge is sufficient model proof", async () => {
    const fixture = modelFixture({ initial: "6Pro" });
    const result = await runInNewContext(buildModelSelectionExpressionForTest("GPT-6 Astra"), fixture.context);
    assert.equal(result.status, "already-selected");
    assert.deepEqual(fixture.clicks, []);
});

test("Korean and English Latest selections require the resulting GPT-6 badge", async () => {
    for (const latest of ["최신", "Latest", "GPT-6 Astra"]) {
        const fixture = modelFixture({ choices: [latest, "GPT-5.6 Sol"] });
        const result = await runInNewContext(buildModelSelectionExpressionForTest("GPT-6 Astra"), fixture.context);
        assert.equal(result.status, "switched", latest);
        assert.equal(result.label, "6 High");
        assert.deepEqual(fixture.clicks, [latest]);
    }
});

test("unavailable GPT-6 and future Latest model changes fail closed", async () => {
    for (const options of [{ choices: ["GPT-5.6 Sol", "GPT-5.5"] }, { target: "7 Pro" }, { target: "Pro" }]) {
        const fixture = modelFixture(options);
        const result = await runInNewContext(buildModelSelectionExpressionForTest("GPT-6 Astra"), fixture.context);
        assert.equal(result.status, "option-not-found");
        assert.ok(result.hint.availableOptions.length > 0);
    }
});

function sliderFixture({ locale = "ko", initial = 0, count = 5, locked = false, maximumLabel = "Pro" } = {}) {
    let position = initial;
    const keys = [];
    const labels = ["Instant", "Medium", "High", "Extra High", maximumLabel].slice(0, count);
    const button = new UiNode("", { "aria-expanded": "true", "aria-controls": "picker" });
    Object.defineProperty(button, "textContent", { get: () => "6 " + labels[position] });
    const surface = new UiNode();
    const simpleView = new UiNode();
    Object.defineProperty(simpleView, "textContent", { get: () => labels[position] + (locale === "ko" ? ", " + count + "개 중 " + (position + 1) + "번째." : ", " + (position + 1) + " of " + count) });
    const control = new UiNode("", { "aria-label": locale === "ko" ? "성능" : "Power", role: "menuitem" });
    control.closest = selector => selector.includes("slider-simple-view") ? simpleView : null;
    control.addEventListener("keydown", event => {
        keys.push(event.key);
        if (!locked && event.key === "ArrowRight") position = Math.min(count - 1, position + 1);
    });
    surface.querySelectorAll = selector => selector.includes('[role="slider"]') ? [control] : [];
    const document = {
        body: new UiNode(),
        getElementById: () => surface,
        querySelector: selector => selector === MODEL_BUTTON_SELECTOR ? button : null,
        querySelectorAll: selector => selector.startsWith('[role="menu"],') ? [surface] : selector.includes("composer-footer-actions") && selector.includes("button.__composer-pill") ? [button] : [],
        dispatchEvent: () => {},
    };
    return { context: domContext(document), keys, position: () => position };
}

test("Korean and English Power controls reach Pro from every lower position", async () => {
    for (const locale of ["ko", "en"]) {
        for (const initial of [0, 1, 2, 3, 4]) {
            const fixture = sliderFixture({ locale, initial });
            const result = await runInNewContext(buildThinkingTimeExpressionForTest("pro", "GPT-6 Astra"), fixture.context);
            assert.equal(result.status, initial === 4 ? "already-selected" : "switched", locale + ":" + initial);
            assert.equal(fixture.position(), 4);
            assert.equal(fixture.keys.length, 4 - initial);
        }
    }
});

test("a locked or non-Pro slider never passes Pro verification", async () => {
    for (const options of [{ locked: true }, { count: 4 }, { maximumLabel: "Max" }]) {
        const fixture = sliderFixture(options);
        const result = await runInNewContext(buildThinkingTimeExpressionForTest("pro", "GPT-6 Astra"), fixture.context);
        assert.ok(["level-unavailable", "selection-unverified"].includes(result.status), result.status);
    }
});

test("recovery verifies both model and Pro before any composer submission", async () => {
    const calls = [];
    const Runtime = { evaluate: async ({ expression }) => {
        const model = expression.includes("selectGpt6Model");
        calls.push(model ? "model" : "effort");
        return { result: { value: { status: "already-selected", label: model ? "6 Pro" : "Pro" } } };
    } };
    await verifyRecoveryModel(Runtime, { options: { model: "gpt-6-astra-pro" } }, () => {});
    assert.deepEqual(calls, ["model", "effort"]);
    await assert.rejects(verifyRecoveryModel({ evaluate: async () => ({ result: { value: { status: "switched", label: "GPT-5.6 Sol" } } }) }, { options: { model: "gpt-6-astra-pro" } }, () => {}), /requires verified GPT-6/);
    await assert.rejects(verifyRecoveryModel({ evaluate: async ({ expression }) => ({ result: { value: expression.includes("selectGpt6Model") ? { status: "already-selected", label: "6 High" } : { status: "level-unavailable", availableLevels: ["Extra High"] } } }) }, { options: { model: "gpt-6-astra-pro" } }, () => {}), /confirmed Pro/);
});
