export async function runProviderSubmissionFlow(adapter, ctx) {
    await adapter.waitForUi(ctx);
    if (adapter.selectMode) {
        await adapter.selectMode(ctx);
    }
    await adapter.typePrompt(ctx);
    await adapter.submitPrompt(ctx);
}
export async function runProviderDomFlow(adapter, ctx) {
    await runProviderSubmissionFlow(adapter, ctx);
    const response = await adapter.waitForResponse(ctx);
    const thoughts = adapter.extractThoughts ? await adapter.extractThoughts(ctx) : null;
    return { ...response, thoughts };
}
export function joinSelectors(selectors) {
    return selectors.join(", ");
}
