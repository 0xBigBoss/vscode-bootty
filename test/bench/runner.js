const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

async function run() {
  const scenarios = parseList(process.env.BOOTTY_BENCH_SCENARIOS, ["ptySmall", "ptyStress"]);
  const renderersEnv = process.env.BOOTTY_BENCH_RENDERERS;
  const renderers = parseList(renderersEnv, ["webgl", "canvas"]);
  const ptyMaxLinesPerFrame = parseNumber(process.env.BOOTTY_BENCH_MAX_LINES_PER_FRAME, undefined);
  const directLinesPerWrite = parseNumber(
    process.env.BOOTTY_BENCH_DIRECT_LINES_PER_WRITE,
    undefined,
  );
  const directWritesPerFrame = parseNumber(
    process.env.BOOTTY_BENCH_DIRECT_WRITES_PER_FRAME,
    undefined,
  );
  const ptyMaxFrameMs = parseNumber(process.env.BOOTTY_BENCH_MAX_FRAME_MS, undefined);
  const ptyMaxBytesPerFrame = parseNumber(process.env.BOOTTY_BENCH_MAX_BYTES_PER_FRAME, undefined);
  const ptyAdaptiveDrain = parseBoolean(process.env.BOOTTY_BENCH_ADAPTIVE_DRAIN, undefined);
  const ptyAdaptiveFrameMs = parseNumber(process.env.BOOTTY_BENCH_ADAPTIVE_FRAME_MS, undefined);
  const ptyAdaptiveQueueThreshold = parseNumber(
    process.env.BOOTTY_BENCH_ADAPTIVE_QUEUE_THRESHOLD,
    undefined,
  );
  const ptyAdaptiveMaxLinesPerFrame = parseNumber(
    process.env.BOOTTY_BENCH_ADAPTIVE_MAX_LINES_PER_FRAME,
    undefined,
  );
  const ptyAdaptiveMaxLinesPerFrameWebgl = parseNumber(
    process.env.BOOTTY_BENCH_ADAPTIVE_MAX_LINES_PER_FRAME_WEBGL,
    undefined,
  );
  const ptyAdaptiveAutoTune = parseBoolean(process.env.BOOTTY_BENCH_ADAPTIVE_AUTO_TUNE, undefined);
  const ptyAdaptiveQueueBytesThreshold = parseNumber(
    process.env.BOOTTY_BENCH_ADAPTIVE_QUEUE_BYTES_THRESHOLD,
    undefined,
  );
  const ptyAdaptiveQueueHysteresisRatio = parseNumber(
    process.env.BOOTTY_BENCH_ADAPTIVE_QUEUE_HYSTERESIS_RATIO,
    undefined,
  );
  const profile =
    process.env.BOOTTY_BENCH_PROFILE === undefined || process.env.BOOTTY_BENCH_PROFILE === "1";
  const timeoutMs = parseNumber(process.env.BOOTTY_BENCH_TIMEOUT_MS, 60000);
  const outputPath = process.env.BOOTTY_BENCH_OUTPUT;
  const command = process.env.BOOTTY_BENCH_COMMAND;

  await vscode.commands.executeCommand("bootty.togglePanel");

  const results = [];
  for (const scenario of scenarios) {
    const renderersForScenario = scenario === "ptySuite" && !renderersEnv ? ["auto"] : renderers;
    for (const renderer of renderersForScenario) {
      // eslint-disable-next-line no-console
      console.log(`[bootty-bench] running ${scenario} (${renderer})...`);
      const result = await vscode.commands.executeCommand("bootty.runBenchmark", {
        scenario,
        renderer,
        location: "panel",
        profile,
        command,
        directLinesPerWrite,
        directWritesPerFrame,
        ptyMaxLinesPerFrame,
        ptyMaxFrameMs,
        ptyMaxBytesPerFrame,
        ptyAdaptiveDrain,
        ptyAdaptiveFrameMs,
        ptyAdaptiveQueueThreshold,
        ptyAdaptiveMaxLinesPerFrame,
        ptyAdaptiveMaxLinesPerFrameWebgl,
        ptyAdaptiveAutoTune,
        ptyAdaptiveQueueBytesThreshold,
        ptyAdaptiveQueueHysteresisRatio,
        timeoutMs,
      });
      results.push(result);
    }
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const resolvedOutput = outputPath
    ? path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(workspaceRoot, outputPath)
    : null;

  if (resolvedOutput) {
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(resolvedOutput, JSON.stringify(results, null, 2));
  }

  // eslint-disable-next-line no-console
  console.log("[bootty-bench] results:", JSON.stringify(results, null, 2));
  if (resolvedOutput) {
    // eslint-disable-next-line no-console
    console.log(`[bootty-bench] saved: ${resolvedOutput}`);
  }

  setTimeout(() => process.exit(0), 200);
}

module.exports = { run };
