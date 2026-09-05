import { MODEL_BUTTON_SELECTOR } from "../constants.js";
import { buildClickDispatcher } from "./domEvents.js";

export function isGpt6ModelLabel(value) {
    const label = String(value ?? "").trim().toLowerCase();
    return /^(?:(?:chat)?gpt[\s-]*)?6(?:[\s-]*astra)?(?:[\s·-]*(?:pro|instant|light|standard|medium|extended|heavy|high|extra high|빠름|표준|높음|매우 높음))?$/.test(label);
}

async function selectGpt6Model(buttonSelector, dispatchClickSequence, matchesModel) {
    const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
    const visible = node => Boolean(node && !node.closest('[inert], [aria-hidden="true"]') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    const selected = node => node?.getAttribute("aria-checked") === "true" || node?.getAttribute("data-state") === "checked";
    const text = node => (node?.textContent ?? "").trim();
    const button = document.querySelector(buttonSelector);
    if (!button) return { status: "button-missing" };
    const picker = () => document.getElementById(button.getAttribute("aria-controls")) ?? document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    const modelRows = () => Array.from(picker()?.querySelectorAll('[role="menuitemradio"]') ?? []).filter(visible);
    const modelToggle = () => Array.from(picker()?.querySelectorAll('[role="menuitem"][aria-expanded]') ?? []).find(visible);
    const observedLabel = () => {
        const labels = [text(button), text(modelToggle()), ...modelRows().filter(selected).map(text)];
        return labels.find(matchesModel) ?? "";
    };
    const closeMenu = () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    };
    if (observedLabel()) {
        const label = observedLabel();
        closeMenu();
        return { status: "already-selected", label };
    }
    if (button.getAttribute("aria-expanded") !== "true") {
        dispatchClickSequence(button);
        await sleep(200);
    }
    const toggle = modelToggle();
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
        dispatchClickSequence(toggle);
        await sleep(250);
    }
    const deadline = performance.now() + 5000;
    let candidate;
    while (performance.now() < deadline) {
        const rows = modelRows();
        candidate = rows.find(node => matchesModel(text(node))) ?? rows.find(node => /^(latest|최신)$/i.test(text(node)));
        if (candidate) break;
        await sleep(100);
    }
    const availableOptions = modelRows().map(text);
    if (!candidate) {
        closeMenu();
        return { status: "option-not-found", hint: { availableOptions } };
    }
    if (!selected(candidate)) {
        dispatchClickSequence(candidate);
        await sleep(250);
    }
    closeMenu();
    const confirmationDeadline = performance.now() + 5000;
    while (performance.now() < confirmationDeadline) {
        const label = observedLabel();
        if (label) return { status: "switched", label };
        await sleep(100);
    }
    return { status: "option-not-found", hint: { availableOptions: [...availableOptions, "Unverified selection: " + text(button)] } };
}

export function buildGpt6ModelSelectionExpression() {
    return "(() => {" + buildClickDispatcher() + "return (" + selectGpt6Model.toString() + ")(" + JSON.stringify(MODEL_BUTTON_SELECTOR) + ", dispatchClickSequence, " + isGpt6ModelLabel.toString() + ");})()";
}
