import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR, MODEL_BUTTON_SELECTOR, } from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
/**
 * Selects a specific thinking time level in ChatGPT's composer.
 *
 * Best-effort: if the chip / menu / option is missing (e.g. ChatGPT moved the
 * effort selector into the per-model trailing button and we can't navigate it,
 * or the language pack uses tokens we don't yet match), we log a debug dump
 * and continue with whatever effort the UI defaults to.
 *
 * @param level - The thinking effort: 'light', 'standard', 'extended', 'heavy', or 'pro'
 */
export async function ensureThinkingTime(Runtime, level, logger, desiredModel) {
    const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);
    const targetModelKind = inferThinkingTargetModelKind(desiredModel);
    const strictProEffort = level === "pro" || (targetModelKind === "pro" && level === "extended");
    switch (result?.status) {
        case "already-selected":
            logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
            return;
        case "switched":
            logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
            return;
        case "chip-not-found":
        case "menu-not-found":
        case "option-not-found":
        case "model-kind-not-found":
        case "trigger-missing":
        case "control-missing":
        case "level-unavailable":
        case "selection-unverified": {
            await logDomFailure(Runtime, logger, `thinking-${result.status}`);
            const kindHint = result.status === "model-kind-not-found" && result.modelKind
                ? ` for ${result.modelKind}`
                : targetModelKind
                    ? ` for ${targetModelKind}`
                    : "";
            const availableLevels = Array.isArray(result.availableLevels)
                ? result.availableLevels.filter((value) => typeof value === "string" && value.trim())
                : [];
            const availableHint = availableLevels.length > 0
                ? ` Available: ${availableLevels.join(", ")}.`
                : "";
            const controlsHint = logger.verbose && Array.isArray(result.controls) && result.controls.length > 0
                ? ` Controls: ${JSON.stringify(result.controls)}.`
                : "";
            const message = `Thinking time: ${result.status.replaceAll("-", " ")}${kindHint} (requested ${capitalizedLevel}).${availableHint}${controlsHint}`;
            if (strictProEffort) {
                throw new Error(`${message} Refusing to submit without confirmed Pro.`);
            }
            logger(`${message} Continuing with ChatGPT default.`);
            return;
        }
        default: {
            await logDomFailure(Runtime, logger, "thinking-time-unknown");
            if (strictProEffort) {
                throw new Error(`Thinking time: unknown outcome selecting ${capitalizedLevel}; refusing to submit without confirmed Pro.`);
            }
            logger(`Thinking time: unknown outcome selecting ${capitalizedLevel}; continuing with ChatGPT default.`);
            return;
        }
    }
}
/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking effort: 'light', 'standard', 'extended', 'heavy', or 'pro'
 */
export async function ensureThinkingTimeIfAvailable(Runtime, level, logger, desiredModel) {
    try {
        const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
        const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);
        switch (result?.status) {
            case "already-selected":
                logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
                return true;
            case "switched":
                logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
                return true;
            case "chip-not-found":
            case "menu-not-found":
            case "option-not-found":
            case "model-kind-not-found":
            case "trigger-missing":
            case "control-missing":
            case "level-unavailable":
            case "selection-unverified":
                if (logger.verbose) {
                    const available = Array.isArray(result.availableLevels) && result.availableLevels.length > 0
                        ? ` Available: ${result.availableLevels.join(", ")}.`
                        : "";
                    logger(`Thinking time: ${result.status.replaceAll("-", " ")}.${available} Continuing with default.`);
                }
                return false;
            default:
                if (logger.verbose) {
                    logger("Thinking time: unknown outcome; continuing with default.");
                }
                return false;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (logger.verbose) {
            logger(`Thinking time selection failed (${message}); continuing with default.`);
            await logDomFailure(Runtime, logger, "thinking-time");
        }
        return false;
    }
}
async function evaluateThinkingTimeSelection(Runtime, level, desiredModel) {
    const outcome = await Runtime.evaluate({
        expression: buildThinkingTimeExpression(level, desiredModel),
        awaitPromise: true,
        returnByValue: true,
    });
    return outcome.result?.value;
}
function buildThinkingTimeExpression(level, desiredModel) {
    const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
    const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
    const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
    const targetLevelLiteral = JSON.stringify(level.toLowerCase());
    const targetModelKindLiteral = JSON.stringify(inferThinkingTargetModelKind(desiredModel));
    return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const TARGET_MODEL_KIND = ${targetModelKindLiteral};

    // Current GPT-5.6 labels plus legacy English and observed CJK variants.
    const LEVEL_TOKENS = {
      light: ['light', 'instant', '轻', '즉시'],
      standard: ['standard', 'medium', '标准', '중간'],
      extended: ['extended', 'high', '扩展', '深度', '加强', '높음'],
      heavy: ['heavy', 'extra high', 'extra-high', 'xhigh', '重度', '加重', '매우 높음'],
      pro: ['pro'],
    };
    const targetTokens = LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];
    const CANONICAL_LEVELS = [
      { label: 'Instant', tokens: LEVEL_TOKENS.light },
      { label: 'Medium', tokens: LEVEL_TOKENS.standard },
      { label: 'High', tokens: LEVEL_TOKENS.extended },
      { label: 'Extra High', tokens: LEVEL_TOKENS.heavy },
      { label: 'Pro', tokens: LEVEL_TOKENS.pro },
    ];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Keep CJK and Hangul characters so localized labels remain matchable.
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\\u4e00-\\u9fa5\\uac00-\\ud7a3]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const matchesLevel = (text) => {
      const t = normalize(text);
      return targetTokens.some((tok) => t.includes(String(tok).toLowerCase()));
    };
    const exactlyMatchesLevel = (text) => {
      const normalized = normalize(text);
      return targetTokens.some((token) => normalized === normalize(String(token)));
    };
    const hasToken = (text, token) => normalize(text).split(' ').includes(token);
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') return true;
      return dataState === 'checked' || dataState === 'selected' || dataState === 'on';
    };
    const hasStableBox = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return Boolean(
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        node.getAttribute?.('aria-hidden') !== 'true'
      );
    };
    const nodeLevelText = (node) => normalize(
      (node?.getAttribute?.('aria-valuetext') ?? '') + ' ' +
      (node?.getAttribute?.('aria-label') ?? '') + ' ' +
      (node?.getAttribute?.('data-value') ?? '') + ' ' +
      (node?.textContent ?? '')
    );
    const canonicalLevelForText = (value) => {
      const normalized = normalize(value);
      if (!normalized) return null;
      for (const entry of CANONICAL_LEVELS) {
        if (entry.tokens.some((token) => normalized === normalize(String(token)))) {
          return entry.label;
        }
      }
      return null;
    };
    const PICKER_SURFACE_SELECTOR = [
      MENU_CONTAINER_SELECTOR,
      '[role="dialog"]',
      '[role="listbox"]',
      '[data-radix-popper-content-wrapper]',
    ].join(', ');
    const visiblePickerSurfaces = () => Array.from(
      document.querySelectorAll(PICKER_SURFACE_SELECTOR)
    ).filter(hasStableBox);
    const controlledSurface = (trigger) => {
      const id = trigger?.getAttribute?.('aria-controls');
      return id ? document.getElementById(id) : null;
    };
    const collectAvailableLevels = (surfaces = visiblePickerSurfaces()) => {
      const labels = [];
      const seen = new Set();
      for (const surface of surfaces) {
        const nodes = [
          surface,
          ...Array.from(surface.querySelectorAll(
            'button, label, span, [role="menuitem"], [role="menuitemradio"], ' +
            '[role="radio"], [role="option"], [aria-valuetext], [data-value]'
          )),
        ];
        for (const node of nodes) {
          if (node !== surface && !hasStableBox(node)) continue;
          const label = canonicalLevelForText(nodeLevelText(node));
          if (label && !seen.has(label)) {
            seen.add(label);
            labels.push(label);
          }
        }
      }
      return labels;
    };
    const collectControlDiagnostics = (surfaces = visiblePickerSurfaces()) => {
      const nodes = surfaces.flatMap((surface) => Array.from(surface.querySelectorAll(
        'button, input, [role], [aria-label], [aria-valuetext], [data-testid]'
      )));
      return Array.from(new Set(nodes)).filter(hasStableBox).map((node) => ({
        tag: node.tagName?.toLowerCase?.() || '',
        role: node.getAttribute?.('role') || '',
        text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        label: node.getAttribute?.('aria-label') || '',
        haspopup: node.getAttribute?.('aria-haspopup') || '',
        expanded: node.getAttribute?.('aria-expanded') || '',
        checked: node.getAttribute?.('aria-checked') || node.getAttribute?.('aria-selected') || '',
        valueText: node.getAttribute?.('aria-valuetext') || '',
        testid: node.getAttribute?.('data-testid') || '',
      })).filter((entry) =>
        entry.text || entry.label || entry.valueText || entry.testid
      ).slice(0, 30);
    };
    const failure = (status, surfaces) => {
      const resolvedSurfaces = surfaces || visiblePickerSurfaces();
      return {
        status,
        availableLevels: collectAvailableLevels(resolvedSurfaces),
        controls: collectControlDiagnostics(resolvedSurfaces),
      };
    };
    const selectedLevelSignalMatches = () => {
      const selected = document.querySelectorAll(
        '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], ' +
        '[data-state="checked"], [data-state="selected"], [data-state="on"]'
      );
      const signalMatches = (node) => {
        const text = nodeLevelText(node);
        return (
          exactlyMatchesLevel(text) ||
          (
            TARGET_LEVEL === 'pro' &&
            hasToken(text, 'pro') &&
            !hasToken(text, 'gpt')
          )
        );
      };
      if (Array.from(selected).some(signalMatches)) {
        return true;
      }
      const composerPills = document.querySelectorAll(
        '[data-testid="composer-footer-actions"] button, button.__composer-pill'
      );
      return Array.from(composerPills).some(signalMatches);
    };
    const waitForConfirmedLevel = async (specificNode = null, timeoutMs = 1800) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (
          (specificNode && optionIsSelected(specificNode) &&
            exactlyMatchesLevel(nodeLevelText(specificNode))) ||
          selectedLevelSignalMatches()
        ) {
          return true;
        }
        await sleep(80);
      }
      return false;
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };

    // ---------- OLD UI: standalone composer chip labelled "Thinking" ----------
    const OLD_CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];
    const findOldChip = () => {
      for (const selector of OLD_CHIP_SELECTORS) {
        for (const btn of document.querySelectorAll(selector)) {
          if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
          // The new model picker pill also reuses .__composer-pill — skip it.
          if (btn.matches?.(MODEL_BUTTON_SELECTOR)) continue;
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          if (aria.includes('thinking') || text.includes('thinking')) return btn;
        }
      }
      return null;
    };
    const findOldEffortMenu = () => {
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
      for (const menu of menus) {
        const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
        if (normalize(label?.textContent ?? '').includes('thinking time')) return menu;
        const text = normalize(menu.textContent ?? '');
        if (text.includes('standard') && text.includes('extended')) return menu;
      }
      return null;
    };
    const findOptionInMenu = (menu) => {
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (
          matchesLevel(item.textContent ?? '') ||
          matchesLevel(item.getAttribute?.('aria-label') ?? '')
        ) {
          return item;
        }
      }
      return null;
    };

    const oldChip = findOldChip();
    if (oldChip) {
      dispatchClickSequence(oldChip);
      const start = performance.now();
      while (performance.now() - start < MAX_WAIT_MS) {
        await sleep(100);
        const menu = findOldEffortMenu();
        if (!menu) continue;
        const opt = findOptionInMenu(menu);
        if (!opt) {
          closeOpenMenus();
          return failure('level-unavailable', [menu]);
        }
        const already = optionIsSelected(opt);
        const label = opt.textContent?.trim?.() || null;
        dispatchClickSequence(opt);
        await sleep(STEP_WAIT_MS);
        const confirmed = await waitForConfirmedLevel(opt);
        closeOpenMenus();
        return confirmed
          ? { status: already ? 'already-selected' : 'switched', label }
          : failure('selection-unverified', [menu]);
      }
      closeOpenMenus();
      return failure('control-missing');
    }

    // ---------- NEW UI: thinking effort lives inside the model picker ----------
    // Each eligible model row carries a trailing button:
    //   [data-model-picker-thinking-effort-action="true"] (role="menuitem", aria-haspopup="menu")
    // Clicking it expands a submenu of effort options. We use aria-controls to
    // resolve the submenu deterministically rather than scoring menu contents.
    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';

    const findModelButton = () => document.querySelector(MODEL_BUTTON_SELECTOR);
    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const KIND_NOT_FOUND = { kindNotFound: true };
    const findEffortRow = (node) => {
      let current = node instanceof HTMLElement ? node.parentElement : null;
      while (current && current !== document.body) {
        if (current.getAttribute?.('data-model-picker-thinking-effort-row') === 'true') {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const rowIsSelected = (row) => {
      if (!(row instanceof HTMLElement)) return false;
      const modelItem = row.querySelector('[data-model-picker-thinking-effort-menu-item="true"], [role="menuitemradio"]');
      if (optionIsSelected(modelItem)) return true;
      return Boolean(
        row.querySelector(
          '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], [data-selected="true"], [data-state="checked"], [data-state="selected"], [data-state="on"]',
        ),
      );
    };
    const rowForTrailing = (trailing) =>
      trailing.closest('[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]');
    const rowTextForTrailing = (trailing) => {
      const row = rowForTrailing(trailing) || findEffortRow(trailing);
      return normalize(
        (row?.getAttribute?.('aria-label') ?? '') + ' ' +
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (row?.textContent ?? '') + ' ' +
        (trailing.getAttribute?.('aria-label') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
    };
    const testIdTextForTrailing = (trailing) => {
      const row = rowForTrailing(trailing) || findEffortRow(trailing);
      return normalize(
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
    };
    const modelKindFromTrailing = (trailing) => {
      const idText = testIdTextForTrailing(trailing);
      if (!idText.includes('model switcher')) return null;
      const modelPart = normalize(idText.replace(/\\bthinking effort\\b.*$/, ''));
      if (hasToken(modelPart, 'pro')) return 'pro';
      if (hasToken(modelPart, 'thinking')) return 'thinking';
      if (hasToken(modelPart, 'instant')) return 'instant';
      return null;
    };
    const trailingMatchesTargetModelKind = (trailing) => {
      if (!TARGET_MODEL_KIND) return false;
      const idKind = modelKindFromTrailing(trailing);
      if (idKind) return idKind === TARGET_MODEL_KIND;
      const text = rowTextForTrailing(trailing);
      if (TARGET_MODEL_KIND === 'pro') {
        return hasToken(text, 'pro') && !hasToken(text, 'thinking');
      }
      if (TARGET_MODEL_KIND === 'thinking') {
        return hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      if (TARGET_MODEL_KIND === 'instant') {
        return hasToken(text, 'instant') && !hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      return false;
    };
    const pickSingleStableTrailing = (trailings) => {
      const visible = trailings.filter((t) => hasStableBox(t));
      return visible.length === 1 ? visible[0] : null;
    };
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      if (trailings.length === 1) return trailings[0];
      // Prefer the trailing button whose model row is currently selected.
      for (const t of trailings) {
        const row = rowForTrailing(t) || findEffortRow(t);
        if (rowIsSelected(row)) return t;
      }
      if (TARGET_MODEL_KIND) {
        const targetTrailings = trailings.filter((t) => trailingMatchesTargetModelKind(t));
        return pickSingleStableTrailing(targetTrailings) || KIND_NOT_FOUND;
      }
      return null;
    };

    const modelBtn = findModelButton();
    if (!modelBtn) {
      return failure('trigger-missing');
    }
    // Open model menu (idempotent — leaves it open if already open).
    if (modelBtn.getAttribute('aria-expanded') !== 'true') {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
    }
    const advancedView = document.querySelector('[data-testid="composer-model-picker-slider-advanced-view"][data-active="true"]');
    const modelViewToggle = advancedView?.closest('[data-testid="composer-intelligence-picker-content"]')?.querySelector('[role="menuitem"][aria-expanded="true"]');
    if (modelViewToggle) {
      dispatchClickSequence(modelViewToggle);
      await sleep(STEP_WAIT_MS);
    }

    const getReasoningSurfaces = () => {
      const surfaces = visiblePickerSurfaces();
      const controlled = controlledSurface(modelBtn);
      if (controlled && !surfaces.includes(controlled)) {
        surfaces.unshift(controlled);
      }
      return surfaces;
    };
    const directEffortNodes = () => {
      const surfaces = getReasoningSurfaces();
      const selector = [
        'button',
        '[role="menuitem"]',
        '[role="menuitemradio"]',
        '[role="radio"]',
        '[role="option"]',
        '[data-radix-collection-item]',
      ].join(', ');
      const nodes = surfaces.flatMap((surface) =>
        Array.from(surface.querySelectorAll(selector))
      );
      return Array.from(new Set(nodes));
    };
    const findDirectEffortOption = () => directEffortNodes().find((node) => {
      if (
        !hasStableBox(node) ||
        node.getAttribute('aria-haspopup') === 'menu'
      ) {
        return false;
      }
      const text = nodeLevelText(node);
      return (
        !hasToken(text, 'gpt') &&
        !hasToken(text, 'sol') &&
        !hasToken(text, 'terra') &&
        !hasToken(text, 'luna') &&
        exactlyMatchesLevel(text)
      );
    }) || findTrailingButtons().find((node) =>
      hasStableBox(node) &&
      node.getAttribute('aria-haspopup') !== 'menu' &&
      exactlyMatchesLevel(rowTextForTrailing(node))
    );

    // GPT-5.6's August 2026 UI exposes reasoning as a real slider. Scope
    // discovery to the open model picker so unrelated page sliders cannot be
    // mistaken for an intelligence control.
    const SLIDER_SELECTOR = [
      '[role="slider"]',
      'input[type="range"]',
      '[data-testid="composer-model-picker-slider-simple-view"] [aria-label="성능"]',
      '[data-testid="composer-model-picker-slider-simple-view"] [aria-label="Power" i]',
    ].join(', ');
    const findReasoningSlider = () => {
      const surfaces = getReasoningSurfaces();
      const scoped = Array.from(new Set(surfaces.flatMap((surface) =>
        Array.from(surface.querySelectorAll(SLIDER_SELECTOR))
      ))).filter(hasStableBox);
      const powerControl = scoped.find((slider) =>
        ['power', '성능'].includes(normalize(slider.getAttribute('aria-label') ?? '')) &&
        Boolean(slider.closest('[data-testid="composer-model-picker-slider-simple-view"]'))
      );
      if (powerControl) return { slider: powerControl, surfaces };
      if (scoped.length === 1) return { slider: scoped[0], surfaces };
      const labelled = scoped.find((slider) => {
        const label = normalize(
          (slider.getAttribute('aria-label') ?? '') + ' ' +
          (slider.getAttribute('data-testid') ?? '')
        );
        return (
          label.includes('reasoning') ||
          label.includes('intelligence') ||
          label.includes('thinking')
        );
      });
      return labelled ? { slider: labelled, surfaces } : null;
    };
    const sliderValueText = (slider) => {
      const explicit = slider?.getAttribute?.('aria-valuetext') ?? '';
      const simpleView = slider?.closest?.(
        '[data-testid="composer-model-picker-slider-simple-view"]'
      );
      return normalize(explicit + ' ' + (simpleView?.textContent ?? ''));
    };
    const sliderHasFivePositions = (slider) =>
      /(?:^|\\s)[1-5]\\s+of\\s+5(?:\\s|$)/.test(sliderValueText(slider)) ||
      /5개\\s*중\\s*[1-5]번째/.test(sliderValueText(slider));
    const sliderValueMatchesTarget = (slider) => {
      const valueText = sliderValueText(slider);
      if (
        exactlyMatchesLevel(valueText) ||
        (
          TARGET_LEVEL === 'pro' &&
          hasToken(valueText, 'pro') &&
          !hasToken(valueText, 'gpt')
        )
      ) {
        return true;
      }
      if (TARGET_LEVEL !== 'pro') return false;
      const valueNow = Number(slider?.getAttribute?.('aria-valuenow'));
      const valueMax = Number(slider?.getAttribute?.('aria-valuemax'));
      return (
        Number.isFinite(valueNow) &&
        Number.isFinite(valueMax) &&
        valueNow === valueMax &&
        selectedLevelSignalMatches()
      );
    };
    const dispatchSliderKey = (slider, key) => {
      try {
        slider.focus?.();
        const common = {
          key,
          code: key,
          bubbles: true,
          cancelable: true,
        };
        slider.dispatchEvent(new KeyboardEvent('keydown', common));
        slider.dispatchEvent(new KeyboardEvent('keyup', common));
        return true;
      } catch {
        return false;
      }
    };
    const setNativeRangeToTarget = (slider) => {
      if (
        typeof HTMLInputElement === 'undefined' ||
        !(slider instanceof HTMLInputElement) ||
        slider.type !== 'range'
      ) {
        return false;
      }
      const minimum = Number(slider.min || slider.getAttribute('aria-valuemin') || 0);
      const maximum = Number(slider.max || slider.getAttribute('aria-valuemax'));
      const step = Number(slider.step || 1);
      const targetIndex = {
        light: 0,
        standard: 1,
        extended: 2,
        heavy: 3,
        pro: 4,
      }[TARGET_LEVEL];
      if (
        !Number.isFinite(minimum) ||
        !Number.isFinite(maximum) ||
        !Number.isFinite(step) ||
        targetIndex == null
      ) {
        return false;
      }
      const targetValue = TARGET_LEVEL === 'pro'
        ? maximum
        : Math.min(maximum, minimum + step * targetIndex);
      try {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set;
        if (setter) setter.call(slider, String(targetValue));
        else slider.value = String(targetValue);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    };
    const waitForSliderConfirmation = async (slider, timeoutMs = 2200) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (sliderValueMatchesTarget(slider) || selectedLevelSignalMatches()) {
          return true;
        }
        await sleep(80);
      }
      return false;
    };

    const selectDirectEffort = async () => {
      const option = findDirectEffortOption();
      if (!option) return null;
      const directSurfaces = getReasoningSurfaces();
      const row = rowForTrailing(option) || findEffortRow(option);
      const already = optionIsSelected(option) || rowIsSelected(row);
      const label = option.textContent?.trim?.() || row?.textContent?.trim?.() || null;
      if (already) {
        closeOpenMenus();
        return { status: 'already-selected', label };
      }
      dispatchClickSequence(option);
      const confirmed = await waitForConfirmedLevel(option);
      closeOpenMenus();
      return confirmed
        ? { status: 'switched', label }
        : failure('selection-unverified', directSurfaces);
    };

    const selectSliderEffort = async () => {
      const match = findReasoningSlider();
      if (!match) return null;
      const { slider, surfaces } = match;
      const availableLevels = collectAvailableLevels(surfaces);
      const targetAvailable =
        availableLevels.some((label) => exactlyMatchesLevel(label)) ||
        (TARGET_LEVEL === 'pro' && sliderHasFivePositions(slider));
      if (sliderValueMatchesTarget(slider)) {
        closeOpenMenus();
        return {
          status: 'already-selected',
          label: TARGET_LEVEL === 'pro' ? 'Pro' : sliderValueText(slider),
        };
      }
      // Never press End on a slider whose maximum may only be Extra High.
      if (!targetAvailable) {
        closeOpenMenus();
        return { status: 'level-unavailable', availableLevels };
      }
      const isPowerControl =
        ['power', '성능'].includes(normalize(slider.getAttribute?.('aria-label') ?? '')) &&
        sliderHasFivePositions(slider);
      let attempted = setNativeRangeToTarget(slider);
      if (!attempted) {
        const key = TARGET_LEVEL === 'pro'
          ? (isPowerControl ? 'ArrowRight' : 'End')
          : 'Home';
        const steps = TARGET_LEVEL === 'pro' && isPowerControl ? 4 : 1;
        for (let step = 0; step < steps; step += 1) {
          attempted = dispatchSliderKey(slider, key);
          if (!attempted) break;
          await sleep(80);
          if (sliderValueMatchesTarget(slider)) break;
        }
      }
      const nativeRange =
        typeof HTMLInputElement !== 'undefined' &&
        slider instanceof HTMLInputElement;
      if (attempted && TARGET_LEVEL !== 'pro' && !nativeRange) {
        const targetIndex = {
          light: 0,
          standard: 1,
          extended: 2,
          heavy: 3,
        }[TARGET_LEVEL] ?? 0;
        for (let index = 0; index < targetIndex; index += 1) {
          dispatchSliderKey(slider, 'ArrowRight');
        }
      }
      if (!attempted) {
        closeOpenMenus();
        return failure('selection-unverified', surfaces);
      }
      const confirmed = await waitForSliderConfirmation(slider);
      const label = TARGET_LEVEL === 'pro' ? 'Pro' : sliderValueText(slider);
      closeOpenMenus();
      return confirmed
        ? { status: 'switched', label }
        : failure('selection-unverified', surfaces);
    };

    // Some picker revisions expose only the current value (for example
    // "Extra High") as a button. Activating it reveals the real range/ticks.
    const findCollapsedReasoningTrigger = () => {
      const candidates = [];
      for (const surface of getReasoningSurfaces()) {
        for (const node of surface.querySelectorAll('button, [role="button"], [aria-haspopup]')) {
          if (!hasStableBox(node)) continue;
          const levelLabel = canonicalLevelForText(nodeLevelText(node));
          if (!levelLabel || exactlyMatchesLevel(levelLabel)) continue;
          candidates.push(node);
        }
      }
      const selected = candidates.find((node) =>
        optionIsSelected(node) || rowIsSelected(rowForTrailing(node) || findEffortRow(node))
      );
      return selected || (candidates.length === 1 ? candidates[0] : null);
    };

    // Prefer a semantic exact-level action when the slider renders clickable
    // ticks/radio rows. This also preserves the immediately preceding UI.
    const directResult = await selectDirectEffort();
    if (directResult) return directResult;
    const sliderResult = await selectSliderEffort();
    if (sliderResult) return sliderResult;

    const collapsedTrigger = findCollapsedReasoningTrigger();
    if (collapsedTrigger) {
      dispatchClickSequence(collapsedTrigger);
      await sleep(STEP_WAIT_MS);
      const expandedDirectResult = await selectDirectEffort();
      if (expandedDirectResult) return expandedDirectResult;
      const expandedSliderResult = await selectSliderEffort();
      if (expandedSliderResult) return expandedSliderResult;
    }

    let trailing = null;
    const trailingDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < trailingDeadline) {
      trailing = pickTrailingForCurrentModel();
      if (trailing) break;
      await sleep(100);
    }
    if (!trailing) {
      const surfaces = getReasoningSurfaces();
      closeOpenMenus();
      return failure('control-missing', surfaces);
    }
    if (trailing.kindNotFound) {
      const surfaces = getReasoningSurfaces();
      closeOpenMenus();
      return {
        ...failure('control-missing', surfaces),
        modelKind: TARGET_MODEL_KIND,
      };
    }

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    // Resolve the effort submenu via aria-controls when ChatGPT exposes it,
    // otherwise fall back to scanning newly opened menus for our level tokens.
    const resolveEffortMenu = () => {
      const id = trailing.getAttribute('aria-controls');
      if (id) {
        const node = document.getElementById(id);
        if (node) return node;
      }
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
      let best = null;
      for (const menu of menus) {
        if (menu === modelBtn || menu.contains(trailing)) continue;
        const text = normalize(menu.textContent ?? '');
        let hits = 0;
        for (const tokens of Object.values(LEVEL_TOKENS)) {
          if (tokens.some((tok) => text.includes(String(tok).toLowerCase()))) hits += 1;
        }
        if (hits >= 2 && (!best || hits > best.hits)) best = { menu, hits };
      }
      return best?.menu ?? null;
    };

    let effortMenu = null;
    const effortDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < effortDeadline) {
      effortMenu = resolveEffortMenu();
      if (effortMenu) break;
      await sleep(100);
    }
    if (!effortMenu) {
      const surfaces = getReasoningSurfaces();
      closeOpenMenus();
      return failure('control-missing', surfaces);
    }

    const targetOption = findOptionInMenu(effortMenu);
    if (!targetOption) {
      closeOpenMenus();
      return failure('level-unavailable', [effortMenu]);
    }

    const already = optionIsSelected(targetOption);
    const label = targetOption.textContent?.trim?.() || null;
    if (already) {
      closeOpenMenus();
      return { status: 'already-selected', label };
    }
    dispatchClickSequence(targetOption);
    const confirmed = await waitForConfirmedLevel(targetOption);
    closeOpenMenus();
    return confirmed
      ? { status: 'switched', label }
      : failure('selection-unverified', [effortMenu]);
  })()`;
}
export function buildThinkingTimeExpressionForTest(level = "extended", desiredModel) {
    return buildThinkingTimeExpression(level, desiredModel);
}
function inferThinkingTargetModelKind(desiredModel) {
    const normalized = (desiredModel ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized)
        return null;
    const tokens = normalized.split(" ");
    if (tokens.includes("pro"))
        return "pro";
    if (tokens.includes("thinking"))
        return "thinking";
    if (tokens.includes("instant"))
        return "instant";
    return null;
}
export function inferThinkingTargetModelKindForTest(desiredModel) {
    return inferThinkingTargetModelKind(desiredModel);
}
