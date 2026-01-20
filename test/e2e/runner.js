const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const READY_TIMEOUT_MS = Number.parseInt(
  process.env.BOOTTY_E2E_READY_TIMEOUT_MS ?? "20000",
  10,
);
const BENCH_TIMEOUT_MS = Number.parseInt(
  process.env.BOOTTY_E2E_BENCH_TIMEOUT_MS ?? "120000",
  10,
);

const FIND_TEXT_POLL_MS = 200;
const FIND_TEXT_LIMIT = 400;

async function waitForText({ terminalId, text, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await vscode.commands.executeCommand("bootty.test.findText", {
      terminalId,
      text,
      limit: FIND_TEXT_LIMIT,
      timeoutMs: 2000,
    });
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function getPanelTerminalIds() {
  const ids = await vscode.commands.executeCommand(
    "bootty.test.getPanelTerminalIds",
  );
  return Array.isArray(ids) ? ids : [];
}

async function waitForNewPanelTerminal(existingIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const existing = new Set(existingIds);
  while (Date.now() < deadline) {
    const ids = await getPanelTerminalIds();
    const next = ids.find((id) => !existing.has(id));
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error("Timed out waiting for a new panel terminal");
}

async function tryFocusPanel() {
  const focusCommands = [
    "workbench.action.focusPanel",
    "workbench.action.focusActiveView",
  ];
  for (const command of focusCommands) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // Try next command.
    }
  }
}

function buildKeyEventsFromText(text) {
  return Array.from(text).map((key) => ({ key }));
}

function readDebugLogValue(config) {
  const inspect = config.inspect("debugLog");
  if (inspect?.globalValue !== undefined) return inspect.globalValue;
  if (inspect?.workspaceValue !== undefined) return inspect.workspaceValue;
  return config.get("debugLog", "");
}

async function waitForConfigValue(config, readValue, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue(config);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readValue(config);
}

function buildColorCommand(label, doneLabel) {
  return `printf '\\x1b[31m${label}\\x1b[0m\\n${doneLabel}\\n'`;
}

function buildBurstColorCommand(label, count, doneLabel, colorCode = "32") {
  return [
    "i=1;",
    `while [ $i -le ${count} ]; do`,
    `printf '\\x1b[${colorCode}m${label}-%03d\\x1b[0m\\n' "$i";`,
    "i=$((i+1));",
    "done;",
    `printf '${doneLabel}\\n'`,
  ].join(" ");
}

function buildEnvCommand(label, envName) {
  return `printf '${label}=%s\\n' "$${envName}"`;
}

function ensureTestFile(workspacePath) {
  const filePath = path.join(workspacePath, "bootty-link-test.txt");
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");
  return filePath;
}

async function run() {
  let linkFilePath = null;
  try {
    const forcedRenderer = process.env.BOOTTY_E2E_RENDERER;
    if (forcedRenderer) {
      if (!["auto", "canvas", "webgl"].includes(forcedRenderer)) {
        throw new Error(
          `Unsupported BOOTTY_E2E_RENDERER value: ${forcedRenderer}`,
        );
      }
      await vscode.workspace
        .getConfiguration("bootty")
        .update("renderer", forcedRenderer, vscode.ConfigurationTarget.Workspace);
    }

    await vscode.commands.executeCommand("bootty.togglePanel");

    const handshake = await vscode.commands.executeCommand(
      "bootty.test.waitForHandshake",
      {
        timeoutMs: READY_TIMEOUT_MS,
        panelTimeoutMs: READY_TIMEOUT_MS,
      },
    );

    assert.ok(handshake, "Handshake result missing");
    assert.equal(handshake.panelReady, true, "Panel did not become ready");
    assert.equal(
      handshake.terminalReady,
      true,
      "Terminal did not become ready",
    );
    assert.equal(
      handshake.location,
      "panel",
      "Handshake terminal is not in panel",
    );

    const panelTerminalId = handshake.terminalId;
    await tryFocusPanel();

    const keyEchoLabel = "BOOTTY_KEY_ECHO_0X_TEST";
    const keyEvents = [
      ...buildKeyEventsFromText(`echo ${keyEchoLabel}`),
      { key: "Enter", code: "Enter" },
    ];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: panelTerminalId,
      keys: keyEvents,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: keyEchoLabel,
      timeoutMs: READY_TIMEOUT_MS,
    });

    const backspaceLabel = "BOOTTY_KEY_BACKSPACE_TEST";
    const backspaceEvents = [
      ...buildKeyEventsFromText(`echo ${backspaceLabel}X`),
      { key: "Backspace", code: "Backspace" },
      { key: "Enter", code: "Enter" },
    ];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: panelTerminalId,
      keys: backspaceEvents,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: backspaceLabel,
      timeoutMs: READY_TIMEOUT_MS,
    });

    const panelText = "BOOTTY_COLOR_TEST_PANEL";
    const panelDone = "BOOTTY_COLOR_DONE_PANEL";
    const panelCommand = buildColorCommand(panelText, panelDone);
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: panelTerminalId,
      data: `${panelCommand}\n`,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: panelText,
      timeoutMs: READY_TIMEOUT_MS,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: panelDone,
      timeoutMs: READY_TIMEOUT_MS,
    });

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspacePath, "Workspace path missing");
    const encodedCwd = encodeURI(workspacePath);
    linkFilePath = ensureTestFile(workspacePath);
    const panelLinkLabel = "BOOTTY_PANEL_LINK_PATH";
    const panelLinkDone = "BOOTTY_PANEL_LINK_DONE";
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: panelTerminalId,
      data: `printf '\\x1b]7;file://localhost${encodedCwd}\\x07'\n`,
    });
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: panelTerminalId,
      data: `printf '${panelLinkLabel} bootty-link-test.txt:2:1\\n${panelLinkDone}\\n'\n`,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: panelLinkDone,
      timeoutMs: READY_TIMEOUT_MS,
    });
    const panelLinkMatches = await vscode.commands.executeCommand(
      "bootty.test.findFileLinks",
      {
        terminalId: panelTerminalId,
        text: "bootty-link-test.txt",
        limit: FIND_TEXT_LIMIT,
        timeoutMs: READY_TIMEOUT_MS,
      },
    );
    assert.ok(panelLinkMatches > 0, "File link not detected in panel terminal");

  const panelIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand("bootty.newTerminalInPanel");
  const secondPanelId = await waitForNewPanelTerminal(
    panelIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: secondPanelId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  const secondPanelLabel = "BOOTTY_PANEL_SECOND";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: secondPanelId,
    data: `printf '${secondPanelLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: secondPanelId,
    text: secondPanelLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const splitIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand("bootty.splitTerminal");
  const splitPanelId = await waitForNewPanelTerminal(
    splitIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: splitPanelId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  const splitPanelLabel = "BOOTTY_PANEL_SPLIT";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: splitPanelId,
    data: `printf '${splitPanelLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: splitPanelId,
    text: splitPanelLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const config = vscode.workspace.getConfiguration("bootty");
  const previousDebugLog = readDebugLogValue(config);
  await vscode.commands.executeCommand("bootty.toggleDebugLog");
  const toggledDebugLog = await waitForConfigValue(
    config,
    readDebugLogValue,
    (value) => value !== previousDebugLog,
  );
  assert.notEqual(toggledDebugLog, previousDebugLog);
  await vscode.commands.executeCommand("bootty.toggleDebugLog");
  const restoredDebugLog = await waitForConfigValue(
    config,
    readDebugLogValue,
    (value) => value === previousDebugLog,
  );
  assert.equal(restoredDebugLog, previousDebugLog);

  const envTermLabel = "BOOTTY_ENV_TERM_PROGRAM";
  const envColorLabel = "BOOTTY_ENV_COLORTERM";
  const envVersionLabel = "BOOTTY_ENV_TERM_PROGRAM_VERSION";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `${buildEnvCommand(envTermLabel, "TERM_PROGRAM")}\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: `${envTermLabel}=bootty`,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `${buildEnvCommand(envColorLabel, "COLORTERM")}\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: `${envColorLabel}=truecolor`,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `${buildEnvCommand(envVersionLabel, "TERM_PROGRAM_VERSION")}\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: `${envVersionLabel}=0.4.0`,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const burstLabel = "BOOTTY_COLOR_BURST";
  const burstDone = "BOOTTY_COLOR_BURST_DONE";
  const burstCommand = buildBurstColorCommand(burstLabel, 50, burstDone, "32");
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `${burstCommand}\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: burstDone,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const afterBurstLabel = "BOOTTY_AFTER_BURST_OK";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `printf '${afterBurstLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: afterBurstLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const editorTerminalId = await vscode.commands.executeCommand(
    "bootty.newTerminalInEditor",
  );
  assert.ok(editorTerminalId, "Editor terminal ID missing");
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: editorTerminalId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  const editorText = "BOOTTY_COLOR_TEST_EDITOR";
  const editorDone = "BOOTTY_COLOR_DONE_EDITOR";
  const editorCommand = buildColorCommand(editorText, editorDone);
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: editorTerminalId,
    data: `${editorCommand}\n`,
  });
  await waitForText({
    terminalId: editorTerminalId,
    text: editorText,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await waitForText({
    terminalId: editorTerminalId,
    text: editorDone,
    timeoutMs: READY_TIMEOUT_MS,
  });

  const linkLabel = "BOOTTY_LINK_PATH";
  const linkDone = "BOOTTY_LINK_DONE";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: editorTerminalId,
    data: `printf '\\x1b]7;file://localhost${encodedCwd}\\x07'\n`,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: editorTerminalId,
    data: `printf '${linkLabel} bootty-link-test.txt:2:1\\n${linkDone}\\n'\n`,
  });
  await waitForText({
    terminalId: editorTerminalId,
    text: linkDone,
    timeoutMs: READY_TIMEOUT_MS,
  });
  const linkMatches = await vscode.commands.executeCommand(
    "bootty.test.findFileLinks",
    {
      terminalId: editorTerminalId,
      text: "bootty-link-test.txt",
      limit: FIND_TEXT_LIMIT,
      timeoutMs: READY_TIMEOUT_MS,
    },
  );
  assert.ok(linkMatches > 0, "File link not detected in editor terminal");

  const result = await vscode.commands.executeCommand("bootty.runBenchmark", {
    scenario: "ptySmall",
    renderer: "auto",
    location: "panel",
    profile: false,
    timeoutMs: READY_TIMEOUT_MS,
  });

  assert.ok(result, "Benchmark result missing");
  assert.equal(result.scenario, "ptySmall");
  assert.ok(
    Number.isFinite(result.durationMs) && result.durationMs > 0,
    "Benchmark duration is invalid",
  );

  const suiteResult = await vscode.commands.executeCommand(
    "bootty.runBenchmark",
    {
      scenario: "ptySuite",
      renderer: "webgl",
      location: "panel",
      profile: false,
      timeoutMs: BENCH_TIMEOUT_MS,
    },
  );
  assert.ok(suiteResult, "Benchmark suite result missing");
  assert.equal(suiteResult.scenario, "ptySuite");
  assert.ok(suiteResult.outputPath, "Benchmark suite outputPath missing");
  assert.ok(
    fs.existsSync(suiteResult.outputPath),
    `Benchmark suite output missing: ${suiteResult.outputPath}`,
  );
  const suiteContents = JSON.parse(
    fs.readFileSync(suiteResult.outputPath, "utf8"),
  );
  assert.ok(suiteContents?.results, "Benchmark suite results missing");
  assert.ok(suiteContents.results.colors, "Benchmark suite colors missing");
  assert.ok(suiteContents.results.throughput, "Benchmark suite throughput missing");

    setTimeout(() => process.exit(0), 200);
  } finally {
    if (linkFilePath && fs.existsSync(linkFilePath)) {
      fs.unlinkSync(linkFilePath);
    }
  }
}

module.exports = { run };
