import { formatFileSection } from "./markdown.js";
/**
 * Build the shared markdown structure for system/user/file sections.
 * Collapses excessive blank lines and trims trailing whitespace to keep
 * snapshots stable across CLI and browser modes.
 */
export function buildPromptMarkdown(systemPrompt, userPrompt, sections) {
    const lines = ["[SYSTEM]", systemPrompt, "", "[USER]", userPrompt, ""];
    sections.forEach((section) => {
        lines.push(formatFileSection(section.displayPath, section.content));
    });
    return lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();
}
