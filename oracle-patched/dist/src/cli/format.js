export function formatCompactNumber(value) {
    if (Number.isNaN(value) || !Number.isFinite(value))
        return "0";
    const abs = Math.abs(value);
    const stripTrailingZero = (text) => text.replace(/\.0$/, "");
    if (abs >= 1_000_000) {
        return `${stripTrailingZero((value / 1_000_000).toFixed(1))}m`;
    }
    if (abs >= 1_000) {
        return `${stripTrailingZero((value / 1_000).toFixed(1))}k`;
    }
    return value.toLocaleString();
}
