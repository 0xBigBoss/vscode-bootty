import fs from "node:fs";
import path from "node:path";

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "event") {
        events.push(obj);
      }
    } catch {
      // Ignore malformed lines
    }
  }
  return events;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function summarizeDurations(events, names) {
  const totals = new Map();
  const counts = new Map();
  const samples = new Map();
  for (const event of events) {
    const { name, dur } = event;
    if (!names.includes(name) || dur === undefined) continue;
    totals.set(name, (totals.get(name) ?? 0) + dur);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const list = samples.get(name) ?? [];
    list.push(dur);
    samples.set(name, list);
  }
  const rows = [];
  for (const name of names) {
    if (!counts.has(name)) continue;
    const total = totals.get(name) ?? 0;
    const count = counts.get(name) ?? 0;
    const avg = count > 0 ? total / count : 0;
    const p95v = p95(samples.get(name) ?? []);
    rows.push({ name, total, count, avg, p95: p95v });
  }
  return rows;
}

function summarizeFrames(events) {
  const frames = events
    .filter((e) => e.name === "bootty:render:frame")
    .map((e) => e.ts)
    .filter((ts) => typeof ts === "number")
    .sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < frames.length; i += 1) {
    deltas.push(frames[i] - frames[i - 1]);
  }
  return {
    count: frames.length,
    first: frames[0],
    last: frames[frames.length - 1],
    avgDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
    p95Delta: p95(deltas),
  };
}

function summarizePtyDrain(events) {
  const drains = events.filter((e) => e.name === "bootty:webview:pty-drain");
  if (drains.length === 0) return null;
  const maxLines = new Set();
  let drainedLines = 0;
  let drainedBytes = 0;
  let adaptiveApplied = 0;
  let queueBefore = 0;
  let queueAfter = 0;
  for (const event of drains) {
    const data = event.data ?? {};
    maxLines.add(data.maxLines);
    drainedLines += data.drainedLines ?? 0;
    drainedBytes += data.drainedBytes ?? 0;
    queueBefore += data.queueSegmentsBefore ?? 0;
    queueAfter += data.queueSegmentsAfter ?? 0;
    if (data.adaptiveApplied) adaptiveApplied += 1;
  }
  return {
    count: drains.length,
    maxLines: [...maxLines].filter((v) => v !== undefined).sort((a, b) => a - b),
    drainedLines,
    drainedBytes,
    adaptiveApplied,
    queueBeforeAvg: drains.length ? queueBefore / drains.length : 0,
    queueAfterAvg: drains.length ? queueAfter / drains.length : 0,
  };
}

function summarizeBenchDirect(events) {
  const start = events.find((e) => e.name === "bootty:webview:bench-direct-write");
  const end = events.find((e) => e.name === "bootty:webview:bench-direct-write-complete");
  if (!start || !end) return null;
  return {
    startTs: start.ts,
    endTs: end.ts,
    spanMs: typeof start.ts === "number" && typeof end.ts === "number" ? end.ts - start.ts : null,
    payloadBytes: start.data?.payloadBytes ?? null,
    repeat: start.data?.repeat ?? null,
    writesPerFrame: start.data?.writesPerFrame ?? null,
    totalWrites: end.data?.totalWrites ?? null,
    totalBytes: end.data?.totalBytes ?? null,
  };
}

function summarizeRuntimeConfig(events) {
  return events.find((e) => e.name === "bootty:webview:runtime-config")?.data;
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function printSummary(filePath) {
  const events = readJsonl(filePath);
  const config = summarizeRuntimeConfig(events);
  const frameStats = summarizeFrames(events);
  const pty = summarizePtyDrain(events);
  const direct = summarizeBenchDirect(events);
  const rendererRows = summarizeDurations(events, [
    "bootty:render:frame",
    "bootty:webgl:render",
    "bootty:webgl:cellbuffer-write",
    "bootty:webgl:cellbuffer-update",
    "bootty:webgl:draw",
    "bootty:canvas:render",
    "bootty:canvas:rows",
    "bootty:term:write",
    "bootty:webview:pty-write",
  ]);

  console.log(`\n${path.basename(filePath)}`);
  if (config) {
    console.log("runtime-config:", config);
  }
  if (direct) {
    console.log(
      `direct-write span: ${direct.spanMs?.toFixed(2)}ms | totalBytes=${direct.totalBytes} writes=${direct.totalWrites}`,
    );
  }
  if (pty) {
    console.log(
      `pty-drain: count=${pty.count} maxLines=${pty.maxLines.join(",")} drainedLines=${pty.drainedLines} drainedBytes=${pty.drainedBytes} adaptiveApplied=${pty.adaptiveApplied}`,
    );
  }
  if (frameStats.count > 0) {
    console.log(
      `frames: ${frameStats.count} span=${formatMs(frameStats.last - frameStats.first)} avgΔ=${formatMs(
        frameStats.avgDelta,
      )} p95Δ=${formatMs(frameStats.p95Delta)}`,
    );
  }
  if (rendererRows.length > 0) {
    console.log("durations:");
    for (const row of rendererRows) {
      console.log(
        `  ${row.name} total ${formatMs(row.total)} count ${row.count} avg ${formatMs(row.avg)} p95 ${formatMs(row.p95)}`,
      );
    }
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/analyze-profile.mjs <file.jsonl> [file.jsonl...]");
  process.exit(1);
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`Missing file: ${file}`);
    continue;
  }
  printSummary(file);
}
