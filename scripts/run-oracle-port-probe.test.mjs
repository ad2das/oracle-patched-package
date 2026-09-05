import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  probeLocalPorts,
  probeLocalPortsSync,
} from "./run-oracle-port-probe.mjs";

test("a non-resolving port connector is bounded by the probe deadline", async () => {
  const startedAt = Date.now();
  const result = await probeLocalPorts([43123], {
    timeoutMs: 40,
    connect: () => new Promise(() => {}),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, null);
  assert.ok(elapsedMs < 1_500, `probe exceeded its deadline: ${elapsedMs}ms`);
});

test("the synchronous bridge finds a live loopback port without probing history one-by-one", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const livePort = address.port;
    const deadServer = net.createServer();
    await new Promise((resolve, reject) => {
      deadServer.once("error", reject);
      deadServer.listen(0, "127.0.0.1", resolve);
    });
    const deadAddress = deadServer.address();
    assert.ok(deadAddress && typeof deadAddress === "object");
    const deadPort = deadAddress.port;
    await new Promise((resolve) => deadServer.close(resolve));
    assert.equal(
      probeLocalPortsSync([deadPort, livePort], { timeoutMs: 100 }),
      livePort,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a closed loopback port returns promptly through the synchronous bridge", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const closedPort = address.port;
  await new Promise((resolve) => server.close(resolve));

  const startedAt = Date.now();
  const result = probeLocalPortsSync([closedPort], { timeoutMs: 100 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, null);
  assert.ok(elapsedMs < 1_000, `closed-port probe exceeded its bound: ${elapsedMs}ms`);
});
