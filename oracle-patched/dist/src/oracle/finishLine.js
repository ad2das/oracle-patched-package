import { formatUSD } from "./format.js";
export function formatElapsedCompact(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return "unknown";
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    if (ms < 60 * 60_000) {
        const minutes = Math.floor(ms / 60_000);
        const seconds = Math.floor((ms % 60_000) / 1000);
        return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
    }
    const hours = Math.floor(ms / (60 * 60_000));
    const minutes = Math.floor((ms % (60 * 60_000)) / 60_000);
    return `${hours}h${minutes.toString().padStart(2, "0")}m`;
}
export function formatFinishLine({ elapsedMs, model, costUsd, tokensPart, summaryExtraParts, detailParts, }) {
    const line1Parts = [
        formatElapsedCompact(elapsedMs),
        typeof costUsd === "number" ? formatUSD(costUsd) : null,
        model,
        tokensPart,
        ...(summaryExtraParts ?? []),
    ];
    const line1 = line1Parts
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" · ");
    const line2Parts = (detailParts ?? []).filter((part) => typeof part === "string" && part.length > 0);
    if (line2Parts.length === 0) {
        return { line1 };
    }
    return { line1, line2: line2Parts.join(" | ") };
}
