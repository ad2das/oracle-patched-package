import { formatBytes } from "./utils.js";
export function buildTokenEstimateSuffix(artifacts) {
    if (artifacts.tokenEstimateIncludesInlineFiles && artifacts.inlineFileCount > 0) {
        const count = artifacts.inlineFileCount;
        const plural = count === 1 ? "" : "s";
        return ` (includes ${count} inline file${plural})`;
    }
    if (artifacts.attachments.length > 0) {
        const count = artifacts.attachments.length;
        const plural = count === 1 ? "" : "s";
        return ` (prompt only; ${count} attachment${plural} excluded)`;
    }
    return "";
}
export function formatAttachmentLabel(attachment) {
    if (typeof attachment.sizeBytes !== "number" || Number.isNaN(attachment.sizeBytes)) {
        return attachment.displayPath;
    }
    return `${attachment.displayPath} (${formatBytes(attachment.sizeBytes)})`;
}
