/**
 * Normalize hidden alias flags so they behave like their primary counterparts.
 *
 * - `--message` maps to `--prompt` when no prompt is provided.
 * - `--include` extends the `--file` list.
 * - `--mode` maps to `--engine` for backward compatibility with older docs/UX.
 */
export function applyHiddenAliases(options, setOptionValue) {
    if (options.include && options.include.length > 0) {
        const mergedFiles = [...(options.file ?? []), ...options.include];
        options.file = mergedFiles;
        setOptionValue?.("file", mergedFiles);
    }
    if (!options.prompt && options.message) {
        options.prompt = options.message;
        setOptionValue?.("prompt", options.message);
    }
    if (!options.engine && options.mode) {
        options.engine = options.mode;
        setOptionValue?.("engine", options.mode);
    }
}
