import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { getOracleHomeDir } from "./oracleHome.js";
function resolveConfigPath() {
    return path.join(getOracleHomeDir(), "config.json");
}
export async function loadUserConfig() {
    const CONFIG_PATH = resolveConfigPath();
    try {
        const raw = await fs.readFile(CONFIG_PATH, "utf8");
        const parsed = JSON5.parse(raw);
        return { config: parsed ?? {}, path: CONFIG_PATH, loaded: true };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return { config: {}, path: CONFIG_PATH, loaded: false };
        }
        console.warn(`Failed to read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
        return { config: {}, path: CONFIG_PATH, loaded: false };
    }
}
export function configPath() {
    return resolveConfigPath();
}
