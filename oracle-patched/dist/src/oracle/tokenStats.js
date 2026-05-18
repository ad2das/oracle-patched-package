import chalk from "chalk";
import { createFileSections } from "./files.js";
export function getFileTokenStats(files, { cwd = process.cwd(), tokenizer, tokenizerOptions, inputTokenBudget, }) {
    if (!files.length) {
        return { stats: [], totalTokens: 0 };
    }
    const sections = createFileSections(files, cwd);
    const stats = sections
        .map((section) => {
        const tokens = tokenizer(section.sectionText, tokenizerOptions);
        const percent = inputTokenBudget ? (tokens / inputTokenBudget) * 100 : undefined;
        return {
            path: section.absolutePath,
            displayPath: section.displayPath,
            tokens,
            percent,
        };
    })
        .sort((a, b) => b.tokens - a.tokens);
    const totalTokens = stats.reduce((sum, entry) => sum + entry.tokens, 0);
    return { stats, totalTokens };
}
export function printFileTokenStats({ stats, totalTokens }, { inputTokenBudget, log = console.log, }) {
    if (!stats.length) {
        return;
    }
    log(chalk.bold("File Token Usage"));
    for (const entry of stats) {
        const percentLabel = inputTokenBudget && entry.percent != null ? `${entry.percent.toFixed(2)}%` : "n/a";
        log(`${entry.tokens.toLocaleString().padStart(10)}  ${percentLabel.padStart(8)}  ${entry.displayPath}`);
    }
    if (inputTokenBudget) {
        const totalPercent = (totalTokens / inputTokenBudget) * 100;
        log(`Total: ${totalTokens.toLocaleString()} tokens (${totalPercent.toFixed(2)}% of ${inputTokenBudget.toLocaleString()})`);
    }
    else {
        log(`Total: ${totalTokens.toLocaleString()} tokens`);
    }
}
