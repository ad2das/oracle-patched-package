import { formatFileSection } from "../oracle/markdown.js";
export function buildAttachmentPlan(sections, { inlineFiles, bundleRequested, maxAttachments = 10, }) {
    if (inlineFiles) {
        const inlineLines = [];
        sections.forEach((section) => {
            inlineLines.push(formatFileSection(section.displayPath, section.content).trimEnd(), "");
        });
        const inlineBlock = inlineLines.join("\n").trim();
        return {
            mode: "inline",
            inlineBlock,
            inlineFileCount: sections.length,
            attachments: [],
            shouldBundle: false,
        };
    }
    const attachments = sections.map((section) => ({
        path: section.absolutePath,
        displayPath: section.displayPath,
        sizeBytes: Buffer.byteLength(section.content, "utf8"),
    }));
    const shouldBundle = bundleRequested || attachments.length > maxAttachments;
    return {
        mode: shouldBundle ? "bundle" : "upload",
        inlineBlock: "",
        inlineFileCount: 0,
        attachments,
        shouldBundle,
    };
}
export function buildCookiePlan(config) {
    if (config?.inlineCookies && config.inlineCookies.length > 0) {
        const source = config.inlineCookiesSource ?? "inline";
        return {
            type: "inline",
            description: `Cookies: inline payload (${config.inlineCookies.length}) via ${source}.`,
        };
    }
    if (config?.cookieSync === false) {
        return { type: "disabled", description: "Cookies: sync disabled (--browser-no-cookie-sync)." };
    }
    const allowlist = config?.cookieNames && config.cookieNames.length > 0
        ? config.cookieNames.join(", ")
        : "all from Chrome profile";
    return { type: "copy", description: `Cookies: copy from Chrome (${allowlist}).` };
}
