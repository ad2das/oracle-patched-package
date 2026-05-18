export function resolveRenderFlag(render, renderMarkdown) {
    return Boolean(renderMarkdown || render);
}
export function resolveRenderPlain(renderPlain, render, renderMarkdown) {
    // Explicit plain render wins when any render flag is set; otherwise false.
    if (!renderPlain)
        return false;
    return Boolean(renderMarkdown || render || renderPlain);
}
