const defaultLabels = [
    { service: 'Chrome Safe Storage', account: 'Chrome' },
    { service: 'Chromium Safe Storage', account: 'Chromium' },
    { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    { service: 'Brave Safe Storage', account: 'Brave' },
    { service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
];
function loadEnvLabels() {
    const raw = process.env.ORACLE_KEYCHAIN_LABELS;
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed
                .map((entry) => (entry && typeof entry === 'object' ? entry : null))
                .filter((entry) => Boolean(entry?.service && entry?.account));
        }
    }
    catch {
        // ignore invalid env payload
    }
    return [];
}
const fallbackLabels = [...loadEnvLabels(), ...defaultLabels];
const disableKeytar = process.env.ORACLE_DISABLE_KEYTAR === '1' || process.env.CI === 'true';
let keytar;
if (disableKeytar) {
    keytar = {
        getPassword: async () => null,
        setPassword: async () => undefined,
        deletePassword: async () => false,
    };
}
else {
    const keytarModule = await import('keytar');
    keytar = (keytarModule.default ?? keytarModule);
    const originalGetPassword = keytar.getPassword.bind(keytar);
    keytar.getPassword = async (service, account) => {
        const primary = await originalGetPassword(service, account);
        if (primary) {
            return primary;
        }
        for (const label of fallbackLabels) {
            if (label.service === service && label.account === account) {
                continue; // already tried
            }
            const value = await originalGetPassword(label.service, label.account);
            if (value) {
                return value;
            }
        }
        return null;
    };
}
export default keytar;
