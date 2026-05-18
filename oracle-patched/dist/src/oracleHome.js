import os from "node:os";
import path from "node:path";
let oracleHomeDirOverride = null;
/**
 * Test-only hook: avoid mutating process.env (shared across Vitest worker threads).
 * This override is scoped to the current Node worker.
 */
export function setOracleHomeDirOverrideForTest(dir) {
    oracleHomeDirOverride = dir;
}
export function getOracleHomeDir() {
    return oracleHomeDirOverride ?? process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
}
