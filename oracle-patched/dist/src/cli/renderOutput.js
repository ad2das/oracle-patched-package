import { ensureShikiReady, renderMarkdownAnsi } from "./markdownRenderer.js";
export function shouldRenderRich(options = {}) {
    return options.richTty ?? Boolean(process.stdout.isTTY);
}
/**
 * Format markdown for CLI output. Uses our ANSI renderer + syntax highlighting
 * when running in a rich TTY; otherwise returns the raw markdown to avoid
 * escape codes in redirected output.
 */
export async function formatRenderedMarkdown(markdown, options = {}) {
    const richTty = shouldRenderRich(options);
    if (!richTty)
        return markdown;
    try {
        await ensureShikiReady();
    }
    catch {
        // If Shiki fails to init (missing terminals/themes), fall back to plain output gracefully.
    }
    try {
        return renderMarkdownAnsi(markdown);
    }
    catch {
        return markdown;
    }
}
