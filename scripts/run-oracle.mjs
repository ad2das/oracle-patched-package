#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const oracleDir = join(repoRoot, "oracle-patched");
const oracleCli = join(oracleDir, "dist", "bin", "oracle-cli.js");
const dependencyProbe = join(oracleDir, "node_modules", "dotenv", "package.json");

if (!existsSync(oracleCli)) {
  console.error(`Patched Oracle CLI not found: ${oracleCli}`);
  process.exit(1);
}

if (!existsSync(dependencyProbe)) {
  console.error("Installing patched Oracle runtime dependencies...");
  const install = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--omit=dev", "--ignore-scripts"],
    { cwd: oracleDir, stdio: "inherit" },
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const run = spawnSync(process.execPath, [oracleCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

process.exit(run.status ?? 1);
