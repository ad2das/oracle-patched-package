function normalizeString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}
export function resolveRemoteServiceConfig({ cliHost, cliToken, userConfig, env = process.env, }) {
    const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
    const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);
    const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
    const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);
    const cliHostValue = normalizeString(cliHost);
    const cliTokenValue = normalizeString(cliToken);
    const host = cliHostValue ?? configBrowserHost ?? envHost;
    const token = cliTokenValue ?? configBrowserToken ?? envToken;
    const hostSource = cliHostValue
        ? "cli"
        : configBrowserHost
            ? "config.browser"
            : envHost
                ? "env"
                : "unset";
    const tokenSource = cliTokenValue
        ? "cli"
        : configBrowserToken
            ? "config.browser"
            : envToken
                ? "env"
                : "unset";
    return { host, token, sources: { host: hostSource, token: tokenSource } };
}
