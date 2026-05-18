#!/usr/bin/env node
import 'dotenv/config';
import { Command, InvalidArgumentError, Option } from 'commander';
import chalk from 'chalk';
import kleur from 'kleur';
import { ensureSessionStorage, initializeSession, updateSessionMetadata, readSessionMetadata, listSessionsMetadata, filterSessionsByRange, createSessionLogWriter, readSessionLog, wait, SESSIONS_DIR, deleteSessionsOlderThan, } from '../src/sessionManager.js';
import { runOracle, MODEL_CONFIGS, parseIntOption, renderPromptMarkdown, readFiles } from '../src/oracle.js';
const VERSION = '1.0.0';
const rawCliArgs = process.argv.slice(2);
const isTty = process.stdout.isTTY;
const HELP_THEME_NAMES = ['aurora', 'ember', 'slate'];
const passthrough = (text) => text;
const wrapForTty = (styler) => (text) => (isTty ? styler(text) : text);
const createTheme = (name, config) => ({
    name,
    banner: wrapForTty(config.banner),
    subtitle: wrapForTty(config.subtitle),
    heading: wrapForTty(config.heading),
    bullet: wrapForTty(config.bullet),
    body: wrapForTty(config.body),
    muted: wrapForTty(config.muted),
    command: wrapForTty(config.command),
    accent: wrapForTty(config.accent),
});
const HELP_THEMES = {
    aurora: createTheme('aurora', {
        banner: (text) => kleur.bold().cyan(text),
        subtitle: (text) => kleur.dim(text),
        heading: (text) => kleur.bold().magenta(text),
        bullet: (text) => kleur.cyan(text),
        body: passthrough,
        muted: (text) => kleur.gray(text),
        command: (text) => kleur.bold().white(text),
        accent: (text) => kleur.magenta(text),
    }),
    ember: createTheme('ember', {
        banner: (text) => kleur.bold().yellow(text),
        subtitle: (text) => kleur.dim(text),
        heading: (text) => kleur.bold().red(text),
        bullet: (text) => kleur.yellow(text),
        body: passthrough,
        muted: (text) => kleur.dim(text),
        command: (text) => kleur.bold().yellow(text),
        accent: (text) => kleur.red(text),
    }),
    slate: createTheme('slate', {
        banner: (text) => kleur.bold().blue(text),
        subtitle: (text) => kleur.dim(text),
        heading: (text) => kleur.bold().white(text),
        bullet: (text) => kleur.blue(text),
        body: passthrough,
        muted: (text) => kleur.gray(text),
        command: (text) => kleur.bold().blue(text),
        accent: (text) => kleur.cyan(text),
    }),
};
const helpThemeName = resolveHelpThemeName(rawCliArgs, process.env.ORACLE_HELP_THEME);
const helpTheme = HELP_THEMES[helpThemeName];
function resolveHelpThemeName(args, envValue) {
    const fromArgs = extractHelpThemeFromArgs(args);
    if (isHelpThemeName(fromArgs)) {
        return fromArgs;
    }
    const fromEnv = envValue?.toLowerCase();
    if (isHelpThemeName(fromEnv)) {
        return fromEnv;
    }
    return 'aurora';
}
function extractHelpThemeFromArgs(args) {
    for (let index = 0; index < args.length; index += 1) {
        const current = args[index];
        if (current === '--help-theme') {
            const maybeTheme = args[index + 1];
            if (maybeTheme) {
                return maybeTheme.toLowerCase();
            }
        }
        else if (current.startsWith('--help-theme=')) {
            return current.split('=')[1]?.toLowerCase();
        }
    }
    return undefined;
}
function isHelpThemeName(value) {
    if (!value) {
        return false;
    }
    return HELP_THEME_NAMES.includes(value);
}
const program = new Command();
program
    .name('oracle')
    .description('One-shot GPT-5 Pro / GPT-5.1 tool for hard questions that benefit from large file context and server-side search.')
    .version(VERSION)
    .option('-p, --prompt <text>', 'User prompt to send to the model.')
    .option('-f, --file <paths...>', 'Paths to files or directories to append to the prompt; repeat, comma-separate, or supply a space-separated list.', collectPaths, [])
    .option('-m, --model <model>', 'Model to target (gpt-5-pro | gpt-5.1).', validateModel, 'gpt-5-pro')
    .option('--files-report', 'Show token usage per attached file (also prints automatically when files exceed the token budget).', false)
    .addOption(new Option('--preview [mode]', 'Preview the request without calling the API (summary | json | full).')
    .choices(['summary', 'json', 'full'])
    .preset('summary'))
    .addOption(new Option('--help-theme <theme>', 'Choose a color palette for --help output.')
    .choices(Array.from(HELP_THEME_NAMES))
    .env('ORACLE_HELP_THEME'))
    .addOption(new Option('--exec-session <id>').hideHelp())
    .option('--render-markdown', 'Emit the assembled markdown bundle for prompt + files and exit.', false)
    .showHelpAfterError('(use --help for usage)');
program
    .command('session [id]')
    .description('Attach to a stored session or list recent sessions when no ID is provided.')
    .option('--hours <hours>', 'Look back this many hours when listing sessions (default 24).', parseFloatOption, 24)
    .option('--limit <count>', 'Maximum sessions to show when listing (max 1000).', parseIntOption, 100)
    .option('--all', 'Include all stored sessions regardless of age.', false)
    .action(async function (sessionId) {
    const sessionOptions = this.opts();
    if (!sessionId) {
        const showExamples = usesDefaultStatusFilters(this);
        await showStatus({
            hours: sessionOptions.all ? Infinity : sessionOptions.hours,
            includeAll: sessionOptions.all,
            limit: sessionOptions.limit,
            showExamples,
        });
        return;
    }
    await attachSession(sessionId);
});
const statusCommand = program
    .command('status')
    .description('List recent sessions (24h window by default).')
    .option('--hours <hours>', 'Look back this many hours (default 24).', parseFloatOption, 24)
    .option('--limit <count>', 'Maximum sessions to show (max 1000).', parseIntOption, 100)
    .option('--all', 'Include all stored sessions regardless of age.', false)
    .action(async function () {
    const statusOptions = this.opts();
    const showExamples = usesDefaultStatusFilters(this);
    await showStatus({
        hours: statusOptions.all ? Infinity : statusOptions.hours,
        includeAll: statusOptions.all,
        limit: statusOptions.limit,
        showExamples,
    });
});
statusCommand
    .command('clear')
    .description('Delete stored sessions older than the provided window (24h default).')
    .option('--hours <hours>', 'Delete sessions older than this many hours (default 24).', parseFloatOption, 24)
    .option('--all', 'Delete all stored sessions.', false)
    .action(async function () {
    const clearOptions = this.opts();
    const result = await deleteSessionsOlderThan({ hours: clearOptions.hours, includeAll: clearOptions.all });
    const scope = clearOptions.all ? 'all stored sessions' : `sessions older than ${clearOptions.hours}h`;
    console.log(`Deleted ${result.deleted} ${result.deleted === 1 ? 'session' : 'sessions'} (${scope}).`);
});
const bold = (text) => (isTty ? kleur.bold(text) : text);
const dim = (text) => (isTty ? kleur.dim(text) : text);
program.addHelpText('beforeAll', () => renderHelpBanner(helpTheme));
program.addHelpText('after', () => renderHelpFooter(helpTheme));
function renderHelpBanner(theme) {
    const subtitle = 'GPT-5 Pro/GPT-5.1 for tough questions with code/file context.';
    return `${theme.banner(`Oracle CLI v${VERSION}`)} ${theme.subtitle(`— ${subtitle}`)}\n`;
}
function renderHelpFooter(theme) {
    const tipLines = [
        `${theme.bullet(' •')} Attach source files for best results, but keep total input under ~196k tokens.`,
        `${theme.bullet(' •')} The model has no built-in knowledge of your project—open with the architecture, key components, and why you’re asking.`,
        `${theme.bullet(' •')} Run ${theme.accent('--files-report')} to see per-file token impact before spending money.`,
        `${theme.bullet(' •')} Non-preview runs spawn detached sessions so requests keep running even if your terminal closes.`,
    ].join('\n');
    const exampleEntries = [
        {
            command: `${program.name()} --prompt "Summarize risks" --file docs/risk.md --files-report --preview`,
            description: 'Inspect tokens + files without calling the API.',
        },
        {
            command: `${program.name()} --prompt "Explain bug" --file src/,docs/crash.log --files-report`,
            description: 'Attach src/ plus docs/crash.log, launch a background session, and capture the Session ID.',
        },
        {
            command: `${program.name()} status --hours 72 --limit 50`,
            description: 'Show sessions from the last 72h (capped at 50 entries).',
        },
        {
            command: `${program.name()} session <sessionId>`,
            description: 'Attach to a running/completed session and stream the saved transcript.',
        },
    ];
    const exampleLines = exampleEntries
        .map((entry) => `${theme.command(`  ${entry.command}`)}\n${theme.muted(`    ${entry.description}`)}`)
        .join('\n\n');
    const paletteList = HELP_THEME_NAMES.map((name) => name === theme.name ? theme.command(name) : theme.accent(name)).join(theme.muted(', '));
    const themeLines = [
        `${theme.bullet(' •')} Current: ${theme.command(theme.name)}`,
        `${theme.bullet(' •')} Try: ${paletteList}`,
        `${theme.bullet(' •')} Switch via ${theme.accent('--help-theme <name>')} or ${theme.accent('ORACLE_HELP_THEME=<name>')}.`,
    ].join('\n');
    return `
${theme.heading('Tips')}
${tipLines}

${theme.heading('Examples')}
${exampleLines}

${theme.heading('Color Themes')}
${themeLines}
`;
}
function collectPaths(value, previous = []) {
    if (!value) {
        return previous;
    }
    const nextValues = Array.isArray(value) ? value : [value];
    return previous.concat(nextValues.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean));
}
function parseFloatOption(value) {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) {
        throw new InvalidArgumentError('Value must be a number.');
    }
    return parsed;
}
function validateModel(value) {
    if (!(value in MODEL_CONFIGS)) {
        throw new InvalidArgumentError(`Unsupported model "${value}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
    }
    return value;
}
function usesDefaultStatusFilters(cmd) {
    const hoursSource = cmd.getOptionValueSource?.('hours') ?? 'default';
    const limitSource = cmd.getOptionValueSource?.('limit') ?? 'default';
    const allSource = cmd.getOptionValueSource?.('all') ?? 'default';
    return hoursSource === 'default' && limitSource === 'default' && allSource === 'default';
}
function resolvePreviewMode(value) {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    if (value === true) {
        return 'summary';
    }
    return undefined;
}
function buildRunOptions(options, overrides = {}) {
    if (!options.prompt) {
        throw new Error('Prompt is required.');
    }
    return {
        prompt: options.prompt,
        model: options.model,
        file: overrides.file ?? options.file ?? [],
        filesReport: overrides.filesReport ?? options.filesReport,
        maxInput: overrides.maxInput ?? options.maxInput,
        maxOutput: overrides.maxOutput ?? options.maxOutput,
        system: overrides.system ?? options.system,
        silent: overrides.silent ?? options.silent,
        search: overrides.search ?? options.search,
        preview: overrides.preview ?? undefined,
        previewMode: overrides.previewMode ?? options.previewMode,
        apiKey: overrides.apiKey ?? options.apiKey,
        sessionId: overrides.sessionId ?? options.sessionId,
    };
}
function buildRunOptionsFromMetadata(metadata) {
    const stored = metadata.options ?? {};
    return {
        prompt: stored.prompt ?? '',
        model: stored.model ?? 'gpt-5-pro',
        file: stored.file ?? [],
        filesReport: stored.filesReport,
        maxInput: stored.maxInput,
        maxOutput: stored.maxOutput,
        system: stored.system,
        silent: stored.silent,
        search: undefined,
        preview: false,
        previewMode: undefined,
        apiKey: undefined,
        sessionId: metadata.id,
    };
}
async function runRootCommand(options) {
    const helpRequested = rawCliArgs.some((arg) => arg === '--help' || arg === '-h');
    if (helpRequested) {
        program.help({ error: false });
        return;
    }
    const previewMode = resolvePreviewMode(options.preview);
    if (rawCliArgs.length === 0) {
        console.log(chalk.yellow('No prompt or subcommand supplied. See `oracle --help` for usage.'));
        program.help({ error: false });
        return;
    }
    if (options.session) {
        await attachSession(options.session);
        return;
    }
    if (options.execSession) {
        await executeSession(options.execSession);
        return;
    }
    if (options.renderMarkdown) {
        if (!options.prompt) {
            throw new Error('Prompt is required when using --render-markdown.');
        }
        const markdown = await renderPromptMarkdown({ prompt: options.prompt, file: options.file, system: options.system }, { cwd: process.cwd() });
        console.log(markdown);
        return;
    }
    if (previewMode) {
        if (!options.prompt) {
            throw new Error('Prompt is required when using --preview.');
        }
        const runOptions = buildRunOptions(options, { preview: true, previewMode });
        await runOracle(runOptions, { log: console.log, write: (chunk) => process.stdout.write(chunk) });
        return;
    }
    if (!options.prompt) {
        throw new Error('Prompt is required when starting a new session.');
    }
    if (options.file && options.file.length > 0) {
        await readFiles(options.file, { cwd: process.cwd() });
    }
    await ensureSessionStorage();
    const baseRunOptions = buildRunOptions(options, { preview: false, previewMode: undefined });
    const sessionMeta = await initializeSession(baseRunOptions, process.cwd());
    const liveRunOptions = { ...baseRunOptions, sessionId: sessionMeta.id };
    await runInteractiveSession(sessionMeta, liveRunOptions);
    console.log(chalk.bold(`Session ${sessionMeta.id} completed`));
}
async function runInteractiveSession(sessionMeta, runOptions) {
    const { logLine, writeChunk, stream } = createSessionLogWriter(sessionMeta.id);
    let headerAugmented = false;
    const combinedLog = (message = '') => {
        if (!headerAugmented && message.startsWith('Oracle (')) {
            headerAugmented = true;
            console.log(`${message}\n${chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`)}`);
            logLine(message);
            return;
        }
        console.log(message);
        logLine(message);
    };
    const combinedWrite = (chunk) => {
        writeChunk(chunk);
        return process.stdout.write(chunk);
    };
    try {
        await updateSessionMetadata(sessionMeta.id, { status: 'running', startedAt: new Date().toISOString() });
        const result = await runOracle(runOptions, {
            log: combinedLog,
            write: combinedWrite,
        });
        if (result.mode !== 'live') {
            throw new Error('Unexpected preview result while running an interactive session.');
        }
        await updateSessionMetadata(sessionMeta.id, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            usage: result.usage,
            elapsedMs: result.elapsedMs,
        });
    }
    catch (error) {
        const message = formatError(error);
        combinedLog(`ERROR: ${message}`);
        await updateSessionMetadata(sessionMeta.id, {
            status: 'error',
            completedAt: new Date().toISOString(),
            errorMessage: message,
        });
        throw error;
    }
    finally {
        stream.end();
    }
}
async function executeSession(sessionId) {
    const metadata = await readSessionMetadata(sessionId);
    if (!metadata) {
        console.error(chalk.red(`No session found with ID ${sessionId}`));
        process.exitCode = 1;
        return;
    }
    const runOptions = buildRunOptionsFromMetadata(metadata);
    const { logLine, writeChunk, stream } = createSessionLogWriter(sessionId);
    try {
        await updateSessionMetadata(sessionId, { status: 'running', startedAt: new Date().toISOString() });
        const result = await runOracle(runOptions, {
            cwd: metadata.cwd,
            log: logLine,
            write: writeChunk,
        });
        if (result.mode !== 'live') {
            throw new Error('Unexpected preview result while executing a stored session.');
        }
        await updateSessionMetadata(sessionId, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            usage: result.usage,
            elapsedMs: result.elapsedMs,
        });
    }
    catch (error) {
        const message = formatError(error);
        logLine(`ERROR: ${message}`);
        await updateSessionMetadata(sessionId, {
            status: 'error',
            completedAt: new Date().toISOString(),
            errorMessage: message,
        });
    }
    finally {
        stream.end();
    }
}
async function showStatus({ hours, includeAll, limit, showExamples = false }) {
    const metas = await listSessionsMetadata();
    const { entries, truncated, total } = filterSessionsByRange(metas, { hours, includeAll, limit });
    if (!entries.length) {
        console.log('No sessions found for the requested range.');
        if (showExamples) {
            printStatusExamples();
        }
        return;
    }
    console.log(chalk.bold('Recent Sessions'));
    for (const entry of entries) {
        const status = (entry.status || 'unknown').padEnd(9);
        const model = (entry.model || 'n/a').padEnd(10);
        const created = entry.createdAt.replace('T', ' ').replace('Z', '');
        console.log(`${created} | ${status} | ${model} | ${entry.id}`);
    }
    if (truncated) {
        console.log(chalk.yellow(`Showing ${entries.length} of ${total} sessions from the requested range. Run "oracle status clear" or delete entries in ${SESSIONS_DIR} to free space, or rerun with --status-limit/--status-all.`));
    }
    if (showExamples) {
        printStatusExamples();
    }
}
function printStatusExamples() {
    console.log('');
    console.log(chalk.bold('Usage Examples'));
    console.log(`${chalk.bold('  oracle status --hours 72 --limit 50')}`);
    console.log(dim('    Show 72h of history capped at 50 entries.'));
    console.log(`${chalk.bold('  oracle status clear --hours 168')}`);
    console.log(dim('    Delete sessions older than 7 days (use --all to wipe everything).'));
    console.log(`${chalk.bold('  oracle session <session-id>')}`);
    console.log(dim('    Attach to a specific running/completed session to stream its output.'));
}
async function attachSession(sessionId) {
    const metadata = await readSessionMetadata(sessionId);
    if (!metadata) {
        console.error(chalk.red(`No session found with ID ${sessionId}`));
        process.exitCode = 1;
        return;
    }
    const reattachLine = buildReattachLine(metadata);
    if (reattachLine) {
        console.log(chalk.blue(reattachLine));
    }
    else {
        console.log(chalk.bold(`Session ${sessionId}`));
    }
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Status: ${metadata.status}`);
    console.log(`Model: ${metadata.model}`);
    let lastLength = 0;
    const printNew = async () => {
        const text = await readSessionLog(sessionId);
        const nextChunk = text.slice(lastLength);
        if (nextChunk.length > 0) {
            process.stdout.write(nextChunk);
            lastLength = text.length;
        }
    };
    await printNew();
    // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate infinite poll
    while (true) {
        const latest = await readSessionMetadata(sessionId);
        if (!latest) {
            break;
        }
        if (latest.status === 'completed' || latest.status === 'error') {
            await printNew();
            if (latest.status === 'error' && latest.errorMessage) {
                console.log(`\nSession failed: ${latest.errorMessage}`);
            }
            if (latest.usage) {
                const usage = latest.usage;
                console.log(`\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`);
            }
            break;
        }
        await wait(1000);
        await printNew();
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function buildReattachLine(metadata) {
    if (!metadata.id) {
        return null;
    }
    const referenceTime = metadata.startedAt ?? metadata.createdAt;
    if (!referenceTime) {
        return null;
    }
    const elapsedLabel = formatRelativeDuration(referenceTime);
    if (!elapsedLabel) {
        return null;
    }
    if (metadata.status === 'running') {
        return `Session ${metadata.id} reattached, request started ${elapsedLabel} ago.`;
    }
    return null;
}
function formatRelativeDuration(referenceIso) {
    const timestamp = Date.parse(referenceIso);
    if (Number.isNaN(timestamp)) {
        return null;
    }
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) {
        return null;
    }
    const seconds = Math.max(1, Math.round(diffMs / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) {
        const parts = [`${hours}h`];
        if (remainingMinutes > 0) {
            parts.push(`${remainingMinutes}m`);
        }
        return parts.join(' ');
    }
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const parts = [`${days}d`];
    if (remainingHours > 0) {
        parts.push(`${remainingHours}h`);
    }
    if (remainingMinutes > 0 && days === 0) {
        parts.push(`${remainingMinutes}m`);
    }
    return parts.join(' ');
}
program.action(async function () {
    const options = this.optsWithGlobals();
    await runRootCommand(options);
});
await program.parseAsync(process.argv).catch((error) => {
    if (error instanceof Error) {
        console.error(chalk.red('✖'), error.message);
    }
    else {
        console.error(chalk.red('✖'), error);
    }
    process.exitCode = 1;
});
