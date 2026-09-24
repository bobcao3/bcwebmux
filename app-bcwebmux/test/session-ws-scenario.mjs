// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runSessionWebSocketScenario(serverPath, deps) {
  const {
    RawClient, attachmentText, concatBytes, createSession, decoder, freePort,
    mutationHeaders, processState, sameBytes, stopServer, unsupportedWebSocket,
    waitFor, waitSession, workerPids,
  } = deps;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const server = spawn(serverPath, ["--config", "/dev/null", "--auth=false", "--port", String(port), "--origin", base, "--max-sessions", "2"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", chunk => { logs += String(chunk); });
  server.stderr.on("data", chunk => { logs += String(chunk); });
  const clients = [];
  let session;
  let workerPid;
  try {
    await waitFor(async () => (await fetch(`${base}/api/server`).catch(() => null))?.ok, 5000, () => `server failed to start\n${logs}`);
    await unsupportedWebSocket(wsUrl, base);
    const malformed = await new RawClient(wsUrl, base, "malformed").connect();
    clients.push(malformed);
    malformed.socket.send(new Uint8Array(64));
    const malformedError = await malformed.waitError();
    assert.equal(malformedError.errorCode, 1);
    assert.equal(malformedError.errorFatal, true);
    await malformed.close();
    const createdResponse = await createSession(base, "ws-protocol-create");
    assert.equal(createdResponse.status, 201);
    session = await createdResponse.json();
    assert.equal(session.state, "running");
    assert.match(session.generation, /^[0-9a-f-]{36}$/);
    await waitFor(async () => (await workerPids(server.pid)).length > 0, 3000, "session worker did not start");
    workerPid = (await workerPids(server.pid))[0];

    const a = await new RawClient(wsUrl, base, "A").connect();
    clients.push(a);
    const aAttachment = await a.attach(session, session.generation, 0n, 0n, 0x101n);
    assert.ok([0, 2].includes(aAttachment.mode), "initial attach should not restore checkpoint");
    await a.heartbeat();
    const aLease = await a.claim(aAttachment);
    let metadata = await waitSession(base, session.id, value => value.attachments === 1 && value.controller?.attachmentId === attachmentText(aAttachment.id), "A controller metadata");
    assert.equal(metadata.controller.leaseEpoch, aLease.toString());
    const pidStart = a.outputLength(aAttachment);
    const pidCommand = "echo PID=$$\nprintf 'PID-'\"END\\n\"\n";
    assert.equal(await a.input(aAttachment, pidCommand), 0);
    await a.waitOutput(aAttachment, "PID-END");
    await a.waitQuiet(aAttachment);
    const pidOutput = a.outputText(aAttachment, pidStart);
    const pidMatch = [...pidOutput.matchAll(/PID=(\d+)/g)].pop();
    assert.ok(pidMatch && Number(pidMatch[1]) > 0, `PID output missing: ${pidOutput}`);
    const retainedCursor = { eventSeq: aAttachment.eventSeq, outputOffset: aAttachment.outputOffset };
    await a.close();
    await waitSession(base, session.id, value => value.state === "running" && value.generation === session.generation && value.attachments === 0, "session detached after A close");

    const b = await new RawClient(wsUrl, base, "B").connect();
    clients.push(b);
    const bAttachment = await b.attach(session, session.generation, retainedCursor.eventSeq, retainedCursor.outputOffset, 0x202n);
    assert.equal(bAttachment.mode, 2, "retained cursor should select tail replay");
    const oldBLease = await b.claim(bAttachment);
    const detachedReplay = concatBytes(bAttachment.outputParts);
    const detachedStart = b.outputLength(bAttachment);
    const detachedCommand = "printf 'DETACHED-TAIL-7\\n'; printf 'TAIL-'\"END\\n\"\n";
    assert.equal(await b.input(bAttachment, detachedCommand), 0);
    await b.waitOutput(bAttachment, "TAIL-END");
    await b.waitQuiet(bAttachment);
    const detachedTail = concatBytes([detachedReplay, b.outputSince(bAttachment, detachedStart)]);
    assert.ok(detachedTail.byteLength > 0);

    const a2 = new RawClient(wsUrl, base, "A-reconnect");
    a2.clientId = a.clientId;
    await a2.connect();
    clients.push(a2);
    const a2Attachment = await a2.attach(session, session.generation, retainedCursor.eventSeq, retainedCursor.outputOffset, 0x303n);
    assert.equal(a2Attachment.mode, 2);
    const a2Replay = concatBytes(a2Attachment.outputParts);
    assert.ok(sameBytes(a2Replay, detachedTail), `replayed detached tail differs or duplicated: A-replay length=${a2Replay.byteLength} value=${JSON.stringify(decoder.decode(a2Replay))}; B-tail length=${detachedTail.byteLength} value=${JSON.stringify(decoder.decode(detachedTail))}`);
    assert.equal(a2Attachment.eventSeq, bAttachment.eventSeq);
    assert.equal(a2Attachment.outputOffset, bAttachment.outputOffset);
    const observer = await new RawClient(wsUrl, base, "observer").connect();
    clients.push(observer);
    const observerAttachment = await observer.attach(session, session.generation, a2Attachment.eventSeq, a2Attachment.outputOffset, 0x404n);
    assert.equal(observerAttachment.mode, 2);
    const latestLease = await a2.claim(a2Attachment);
    const duplicatePidStart = a2.outputLength(a2Attachment);
    assert.equal(await a2.input(a2Attachment, pidCommand), 1);
    await a2.waitQuiet(a2Attachment);
    assert.equal(a2.outputLength(a2Attachment), duplicatePidStart);
    assert.ok(latestLease > oldBLease);
    metadata = await waitSession(base, session.id, value => value.attachments === 3 && value.controller?.attachmentId === attachmentText(a2Attachment.id), "latest controller metadata");
    assert.equal(metadata.controller.leaseEpoch, latestLease.toString());
    assert.equal(await b.input(bAttachment, "printf 'STALE\\n'\n", oldBLease), 2);
    assert.equal(await b.resizeError(bAttachment, 90, 30, oldBLease), 8);

    const aOutputStart = a2.outputLength(a2Attachment);
    const observerOutputStart = observer.outputLength(observerAttachment);
    assert.equal(await a2.input(a2Attachment, "printf 'CURRENT-OUTPUT-9\\n'; printf 'CURRENT-'\"END\\n\"\n"), 0);
    await a2.waitOutput(a2Attachment, "CURRENT-END");
    await observer.waitOutput(observerAttachment, "CURRENT-END");
    assert.ok(sameBytes(a2.outputSince(a2Attachment, aOutputStart), observer.outputSince(observerAttachment, observerOutputStart)), "observer output diverged");

    const compressionRawStart = a2Attachment.outputRawBytes;
    const compressionCompressedStart = a2Attachment.outputCompressedBytes;
    const compressionWireStart = a2Attachment.outputWireBytes;
    const compressionEventStart = a2Attachment.outputEventCount;
    const sessionSocketPath = fileURLToPath(new URL("../src/SessionSocket.zig", import.meta.url));
    assert.equal(await a2.input(a2Attachment, `for i in 1 2 3 4 5 6; do cat ${shellQuote(sessionSocketPath)}; done; printf 'PTY-COMP'\"RESSION-END\\n\"\n`), 0);
    await a2.waitOutput(a2Attachment, "PTY-COMPRESSION-END");
    await a2.waitQuiet(a2Attachment);
    const compressionRawDelta = a2Attachment.outputRawBytes - compressionRawStart;
    const compressionCompressedDelta = a2Attachment.outputCompressedBytes - compressionCompressedStart;
    const compressionWireDelta = a2Attachment.outputWireBytes - compressionWireStart;
    const compressionEventDelta = a2Attachment.outputEventCount - compressionEventStart;
    const compressionBodyRatio = compressionRawDelta / compressionCompressedDelta;
    const compressionRatio = compressionRawDelta / compressionWireDelta;
    assert.ok(compressionRawDelta > 4096 && compressionWireDelta > 0 && compressionRatio >= 8, `PTY compression regression: raw=${compressionRawDelta}, compressed=${compressionCompressedDelta}, events=${compressionEventDelta}, bodyRatio=${compressionBodyRatio}, fullWireRatio=${compressionRatio}`);

    const resizeBefore = a2Attachment.eventSeq;
    const canonical = await a2.resize(a2Attachment, 100, 33);
    assert.equal(canonical.epoch, latestLease);
    metadata = await waitSession(base, session.id, value => value.geometry.cols === 100 && value.geometry.rows === 33, "resize metadata before ordered event");
    const resizeEvent = await a2.waitEvent(a2Attachment, event => event.kind === 1, "ordered resize event");
    assert.ok(resizeEvent.seq > resizeBefore);
    assert.equal(resizeEvent.seq, a2Attachment.eventSeq);
    assert.deepEqual(resizeEvent.geometry, { cols: 100, rows: 33, cellWidthPx: 8, cellHeightPx: 16 });
    const sizeStart = a2.outputLength(a2Attachment);
    assert.equal(await a2.input(a2Attachment, "printf 'SIZE='; stty size; printf '\\nSIZE-'\"END\\n\"\n"), 0);
    await a2.waitOutput(a2Attachment, "SIZE-END");
    assert.match(a2.outputText(a2Attachment, sizeStart), /SIZE=33 100/);
    metadata = await waitSession(base, session.id, value => value.geometry.cols === 100 && value.geometry.rows === 33 && value.controller?.attachmentId === attachmentText(a2Attachment.id), "resize metadata");

    await a2.waitQuiet(a2Attachment);
    const lowCredit = await new RawClient(wsUrl, base, "low-credit").connect();
    clients.push(lowCredit);
    const lowCreditError = await lowCredit.attachExpectError(session, session.generation, 0n, 0n, 0x808n, 1);
    assert.equal(lowCreditError.errorCode, 7);
    assert.equal(lowCreditError.errorFatal, false);
    await lowCredit.heartbeat();
    await lowCredit.close();
    const freshReplay = await new RawClient(wsUrl, base, "fresh-replay").connect();
    clients.push(freshReplay);
    const freshReplayAttachment = await freshReplay.attach(session, session.generation, 0n, 0n, 0x707n);
    assert.equal(freshReplayAttachment.mode, 2);
    assert.deepEqual(freshReplayAttachment.replayGeometry, { cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 });
    assert.deepEqual(freshReplayAttachment.geometry, { cols: 100, rows: 33, cellWidthPx: 8, cellHeightPx: 16 });
    const slow = await new RawClient(wsUrl, base, "slow").connect();
    clients.push(slow);
    const slowAttachment = await slow.attach(session, session.generation, a2Attachment.eventSeq, a2Attachment.outputOffset, 0x606n, 1, 0);
    const a2FlowStart = a2.outputLength(a2Attachment);
    const slowFlowStart = slow.outputLength(slowAttachment);
    assert.equal(await a2.input(a2Attachment, "printf 'FLOW-CREDIT-END\\n'\n"), 0);
    await a2.waitOutput(a2Attachment, "FLOW-CREDIT-END");
    await slow.waitQuiet(slowAttachment, 200);
    assert.equal(slow.outputLength(slowAttachment), slowFlowStart);
    await slow.credit(slowAttachment, 1024 * 1024);
    await slow.waitOutput(slowAttachment, "FLOW-CREDIT-END");
    assert.ok(sameBytes(slow.outputSince(slowAttachment, slowFlowStart), a2.outputSince(a2Attachment, a2FlowStart)));

    assert.equal(await a2.input(a2Attachment, "sleep 1000\n"), 0);
    assert.equal(await a2.input(a2Attachment, new Uint8Array(64 * 1024).fill(0x78)), 0);
    const terminateResponse = await fetch(`${base}/api/sessions/${session.id}/terminate`, {
      method: "POST", headers: mutationHeaders(base, "ws-protocol-terminate"),
    });
    assert.equal(terminateResponse.status, 202);
    assert.equal((await terminateResponse.json()).generation, session.generation);
    metadata = await waitSession(base, session.id, value => value.state === "exited" && value.checkpointBytes > 0 && value.checkpointEventSeq === value.eventSeq, "session exit checkpoint");
    await a2.until(() => a2Attachment.exited, "A EXITED");

    const finalClient = await new RawClient(wsUrl, base, "checkpoint").connect();
    clients.push(finalClient);
    const finalAttachment = await finalClient.attach(session, session.generation, 0n, 0n, 0x505n);
    assert.equal(finalAttachment.mode, 1, "fresh retained-generation attach should restore checkpoint");
    assert.ok(finalAttachment.checkpointChunks > 0);
    await finalClient.until(() => finalAttachment.exited, "checkpoint EXITED");
    assert.equal(finalAttachment.eventSeq, BigInt(metadata.eventSeq));
    assert.equal(finalAttachment.outputOffset, BigInt(metadata.outputOffset));

    await Promise.all([b.detach(bAttachment), a2.detach(a2Attachment), observer.detach(observerAttachment), freshReplay.detach(freshReplayAttachment), slow.detach(slowAttachment), finalClient.detach(finalAttachment)]);
    await waitSession(base, session.id, value => value.attachments === 0 && value.state === "exited", "all websocket attachments detached");
    const deleted = await fetch(`${base}/api/sessions/${session.id}`, {
      method: "DELETE", headers: mutationHeaders(base, "ws-protocol-delete"),
    });
    assert.equal(deleted.status, 204);
    assert.equal((await fetch(`${base}/api/sessions/${session.id}`)).status, 404);
  } finally {
    if (session && server.exitCode === null) {
      await fetch(`${base}/api/sessions/${session.id}/terminate`, {
        method: "POST", headers: mutationHeaders(base, "ws-protocol-cleanup"),
      }).catch(() => {});
      await waitSession(base, session.id, value => value.state === "exited", "cleanup exit").catch(() => {});
    }
    for (const client of clients.reverse()) await client.close();
    await stopServer(server);
    if (workerPid) await waitFor(async () => !(await processState(workerPid)), 1500, () => `worker ${workerPid} leaked after shutdown\n${logs}`);
  }
}
