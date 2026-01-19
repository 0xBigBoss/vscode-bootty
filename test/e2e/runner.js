const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  await vscode.commands.executeCommand("bootty.togglePanel");

  const result = await vscode.commands.executeCommand("bootty.runBenchmark", {
    scenario: "ptySmall",
    renderer: "auto",
    location: "panel",
    profile: false,
    timeoutMs: 20000,
  });

  assert.ok(result, "Benchmark result missing");
  assert.equal(result.scenario, "ptySmall");
  assert.ok(
    Number.isFinite(result.durationMs) && result.durationMs > 0,
    "Benchmark duration is invalid",
  );

  setTimeout(() => process.exit(0), 200);
}

module.exports = { run };
