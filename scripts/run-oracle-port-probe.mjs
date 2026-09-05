import { spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

// Local Chrome accepts a TCP handshake quickly, but a busy machine should not
// be treated as proof that a live DevTools port disappeared.
export const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1_000;

export function normalizePort(value) {
  const port = Number(String(value ?? "").trim());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function uniquePorts(values) {
  const ports = new Set();
  for (const value of values ?? []) {
    const port = normalizePort(value);
    if (port !== null) ports.add(port);
  }
  return [...ports];
}

function defaultConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Probe candidate loopback ports concurrently with one bounded deadline.
 * `connect` is injectable so the timeout contract can be tested without a
 * browser or a network dependency.
 */
export function probeLocalPorts(
  values,
  { host = "127.0.0.1", timeoutMs = DEFAULT_PORT_PROBE_TIMEOUT_MS, connect = defaultConnect } = {},
) {
  const ports = uniquePorts(values);
  const boundedTimeout = Math.max(1, Number(timeoutMs) || DEFAULT_PORT_PROBE_TIMEOUT_MS);
  if (ports.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let remaining = ports.length;
    const finish = (port) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(port);
    };
    const deadline = setTimeout(() => finish(null), boundedTimeout);
    for (const port of ports) {
      Promise.resolve()
        .then(() => connect(host, port, boundedTimeout))
        .then((open) => {
          if (open) {
            finish(port);
            return;
          }
          remaining -= 1;
          if (remaining === 0) finish(null);
        })
        .catch(() => {
          remaining -= 1;
          if (remaining === 0) finish(null);
        });
    }
  });
}

const helperUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
const syncProbeScript = `
  import { probeLocalPorts } from ${JSON.stringify(helperUrl)};
  const ports = JSON.parse(process.argv[1]);
  const timeoutMs = Number(process.argv[2]);
  const host = process.argv[3] || "127.0.0.1";
  const result = await probeLocalPorts(ports, { host, timeoutMs });
  if (result !== null) process.stdout.write(String(result));
`;

/**
 * Synchronous bridge for the wrapper's preflight path. The child probes all
 * candidates concurrently, so stale history cannot multiply a TCP timeout by
 * the number of old sessions.
 */
export function probeLocalPortsSync(
  values,
  { host = "127.0.0.1", timeoutMs = DEFAULT_PORT_PROBE_TIMEOUT_MS } = {},
) {
  const ports = uniquePorts(values);
  if (ports.length === 0) return null;
  const boundedTimeout = Math.max(1, Number(timeoutMs) || DEFAULT_PORT_PROBE_TIMEOUT_MS);
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", syncProbeScript, JSON.stringify(ports), String(boundedTimeout), host],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: boundedTimeout + 1_000,
    },
  );
  if (result.status !== 0 || result.signal) return null;
  return normalizePort(result.stdout?.trim());
}
