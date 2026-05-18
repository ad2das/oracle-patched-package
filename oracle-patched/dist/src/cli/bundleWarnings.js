import chalk from "chalk";
export function warnIfOversizeBundle(estimatedTokens, threshold = 196_000, log = console.log) {
    if (Number.isNaN(estimatedTokens) || estimatedTokens <= threshold) {
        return false;
    }
    const msg = `Warning: bundle is ~${estimatedTokens.toLocaleString()} tokens (>${threshold.toLocaleString()}); may exceed model limits.`;
    log(chalk.red(msg));
    return true;
}
