export function normalizeBrowserModelStrategy(value) {
    if (value == null) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (normalized === "select" || normalized === "current" || normalized === "ignore") {
        return normalized;
    }
    throw new Error(`Invalid browser model strategy: "${value}". Expected "select", "current", or "ignore".`);
}
