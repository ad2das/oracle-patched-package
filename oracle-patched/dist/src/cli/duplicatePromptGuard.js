import chalk from "chalk";
function normalizeRunSignature(prompt, browserFollowUps) {
    const followUps = (browserFollowUps ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join("\n\n--- browser follow-up ---\n\n");
    return [prompt.trim(), followUps].filter(Boolean).join("\n\n--- browser follow-ups ---\n\n");
}
export async function shouldBlockDuplicatePrompt({ prompt, browserFollowUps, force, sessionStore, log = console.log, }) {
    if (force)
        return false;
    const normalized = prompt?.trim();
    if (!normalized)
        return false;
    const signature = normalizeRunSignature(normalized, browserFollowUps);
    const running = (await sessionStore.listSessions()).filter((entry) => entry.status === "running");
    const duplicate = running.find((entry) => normalizeRunSignature(entry.options?.prompt?.trim?.() ?? "", entry.options?.browserFollowUps) === signature);
    if (!duplicate)
        return false;
    log(chalk.yellow(`A session with the same prompt is already running (${duplicate.id}). Reattach with "oracle session ${duplicate.id}" or rerun with --force to start another run.`));
    return true;
}
