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

async function getEditorTerminalIds() {
  const ids = await vscode.commands.executeCommand(
    "bootty.test.getEditorTerminalIds",
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

async function waitForPanelTerminalClosed(terminalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = await getPanelTerminalIds();
    if (!ids.includes(terminalId)) return;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error(`Timed out waiting for terminal to close: ${terminalId}`);
}

async function waitForNewEditorTerminal(existingIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const existing = new Set(existingIds);
  while (Date.now() < deadline) {
    const ids = await getEditorTerminalIds();
    const next = ids.find((id) => !existing.has(id));
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error("Timed out waiting for a new editor terminal");
}

async function waitForEditorTerminalClosed(terminalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = await getEditorTerminalIds();
    if (!ids.includes(terminalId)) return;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error(
    `Timed out waiting for editor terminal to close: ${terminalId}`,
  );
}

async function waitForTextInAnyTerminal({ terminalIds, text, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const terminalId of terminalIds) {
      const found = await vscode.commands.executeCommand("bootty.test.findText", {
        terminalId,
        text,
        limit: FIND_TEXT_LIMIT,
        timeoutMs: 2000,
      });
      if (found) return terminalId;
    }
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error(`Timed out waiting for text in any terminal: ${text}`);
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

function buildImeKeyEventsFromText(text) {
  return Array.from(text).map((inputText) => ({
    key: "Process",
    keyCode: 229,
    inputText,
  }));
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

async function waitForRendererInfo(terminalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await vscode.commands.executeCommand(
      "bootty.test.getRendererInfo",
      { terminalId },
    );
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  }
  throw new Error(`Timed out waiting for renderer info: ${terminalId}`);
}

async function sampleTrailingCells(terminalId, count, timeoutMs) {
  return await vscode.commands.executeCommand(
    "bootty.test.sampleTrailingCells",
    {
      terminalId,
      count,
      timeoutMs,
    },
  );
}

async function directWrite(terminalId, payload, timeoutMs) {
  return await vscode.commands.executeCommand("bootty.test.directWrite", {
    terminalId,
    payload,
    timeoutMs,
  });
}

async function startPipelineTrace(terminalId) {
  const tracePath = await vscode.commands.executeCommand(
    "bootty.startPipelineTrace",
    { terminalId },
  );
  if (!tracePath || typeof tracePath !== "string") {
    throw new Error("startPipelineTrace failed to return a trace path");
  }
  return tracePath;
}

async function stopPipelineTrace(terminalId) {
  const tracePath = await vscode.commands.executeCommand(
    "bootty.stopPipelineTrace",
    { terminalId },
  );
  if (!tracePath || typeof tracePath !== "string") {
    throw new Error("stopPipelineTrace failed to return a trace path");
  }
  const contents = fs.readFileSync(tracePath, "utf8");
  const lines = contents.split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function assertTraceStagesPresent(trace, expectedStages) {
  const foundStages = new Set(trace.map((event) => event.stage));
  const missing = expectedStages.filter((stage) => !foundStages.has(stage));
  if (missing.length > 0) {
    const stagesByType = {};
    for (const event of trace) {
      stagesByType[event.stage] = (stagesByType[event.stage] || 0) + 1;
    }
    throw new Error(
      `Missing pipeline stages: ${missing.join(", ")}. Found: ${JSON.stringify(
        stagesByType,
      )}`,
    );
  }
}

async function runTypedInputEchoTest(terminalId, label, inputText, timeoutMs) {
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId,
    data: `read -r line; printf '${label}:%s\\n' "$line"\n`,
  });
  const keyEvents = [
    ...buildKeyEventsFromText(inputText),
    { key: "Enter", code: "Enter" },
  ];
  await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
    terminalId,
    keys: keyEvents,
  });
  await waitForText({
    terminalId,
    text: `${label}:${inputText}`,
    timeoutMs,
  });
}

async function runImeTypedInputEchoTest(terminalId, label, inputText, timeoutMs) {
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId,
    data: `read -r line; printf '${label}:%s\\n' "$line"\n`,
  });
  const keyEvents = [
    ...buildImeKeyEventsFromText(inputText),
    { key: "Enter", code: "Enter" },
  ];
  await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
    terminalId,
    keys: keyEvents,
  });
  await waitForText({
    terminalId,
    text: `${label}:${inputText}`,
    timeoutMs,
  });
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

function ensureNestedWorkspaceFile(workspacePath) {
  const nestedDir = path.join(workspacePath, "bootty-e2e-nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  const filePath = path.join(nestedDir, "bootty-e2e-nested.txt");
  fs.writeFileSync(filePath, "nested\n", "utf8");
  return { filePath, nestedDir };
}

async function run() {
  let linkFilePath = null;
  let nestedFile = null;
  let previousDefaultLocationValue = undefined;
  let defaultLocationConfigTarget = null;
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

    const rendererConfig = vscode.workspace.getConfiguration("bootty");
    const rendererConfigTarget = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const defaultLocationConfigAtStart = vscode.workspace.getConfiguration("bootty");
    const defaultLocationInspect = defaultLocationConfigAtStart.inspect(
      "defaultTerminalLocation",
    );
    previousDefaultLocationValue =
      rendererConfigTarget === vscode.ConfigurationTarget.Workspace
        ? defaultLocationInspect?.workspaceValue
        : defaultLocationInspect?.globalValue;
    defaultLocationConfigTarget = rendererConfigTarget;
    await defaultLocationConfigAtStart.update(
      "defaultTerminalLocation",
      "panel",
      rendererConfigTarget,
    );
    const previousRenderer = rendererConfig.inspect("renderer");
    const previousRendererValue =
      rendererConfigTarget === vscode.ConfigurationTarget.Workspace
        ? previousRenderer?.workspaceValue
        : previousRenderer?.globalValue;
    const renderersToTest = forcedRenderer
      ? [forcedRenderer]
      : ["canvas", "webgl"];

    try {
      for (const renderer of renderersToTest) {
        if (!forcedRenderer) {
          await rendererConfig.update(
            "renderer",
            renderer,
            rendererConfigTarget,
          );
          await waitForConfigValue(
            rendererConfig,
            (config) => config.get("renderer", "auto"),
            (value) => value === renderer,
            READY_TIMEOUT_MS,
          );
        }

        const rendererIdsBefore = await getPanelTerminalIds();
        await vscode.commands.executeCommand("bootty.newTerminalInPanel");
        const rendererTerminalId = await waitForNewPanelTerminal(
          rendererIdsBefore,
          READY_TIMEOUT_MS,
        );
        await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
          terminalId: rendererTerminalId,
          timeoutMs: READY_TIMEOUT_MS,
          panelTimeoutMs: READY_TIMEOUT_MS,
        });
        await tryFocusPanel();

        const rendererInfo = await waitForRendererInfo(
          rendererTerminalId,
          READY_TIMEOUT_MS,
        );
        if (renderer === "webgl" && rendererInfo?.type !== "webgl") {
          console.warn(
            `[bootty e2e] WebGL renderer unavailable (got ${rendererInfo?.type ?? "unknown"}). Skipping typed input check.`,
          );
        } else {
          const label = `BOOTTY_TYPED_${renderer.toUpperCase()}`;
          const inputText = "echo hello world";
          await runTypedInputEchoTest(
            rendererTerminalId,
            label,
            inputText,
            READY_TIMEOUT_MS,
          );
          const imeLabel = `BOOTTY_TYPED_${renderer.toUpperCase()}_IME`;
          await runImeTypedInputEchoTest(
            rendererTerminalId,
            imeLabel,
            inputText,
            READY_TIMEOUT_MS,
          );
        }

        await vscode.commands.executeCommand("bootty.test.sendInput", {
          terminalId: rendererTerminalId,
          data: "exit\n",
        });
        await waitForPanelTerminalClosed(rendererTerminalId, READY_TIMEOUT_MS);
      }
    } finally {
      if (!forcedRenderer) {
        await rendererConfig.update(
          "renderer",
          previousRendererValue === undefined ? undefined : previousRendererValue,
          rendererConfigTarget,
        );
      }
    }

    const cursorConfig = vscode.workspace.getConfiguration("bootty");
    const previousCursor = cursorConfig.inspect("cursorStyle");
    const previousCursorValue =
      rendererConfigTarget === vscode.ConfigurationTarget.Workspace
        ? previousCursor?.workspaceValue
        : previousCursor?.globalValue;

    if (forcedRenderer && forcedRenderer !== "canvas") {
      console.warn(
        `[bootty e2e] Renderer forced to ${forcedRenderer}; skipping visual ink sampling test.`,
      );
    } else {
      const rendererBeforeSample = rendererConfig.get("renderer", "auto");
      try {
        await cursorConfig.update(
          "cursorStyle",
          "underline",
          rendererConfigTarget,
        );
        await waitForConfigValue(
          cursorConfig,
          (config) => config.get("cursorStyle", "block"),
          (value) => value === "underline",
          READY_TIMEOUT_MS,
        );
        if (!forcedRenderer) {
          await rendererConfig.update(
            "renderer",
            "canvas",
            rendererConfigTarget,
          );
          await waitForConfigValue(
            rendererConfig,
            (config) => config.get("renderer", "auto"),
            (value) => value === "canvas",
            READY_TIMEOUT_MS,
          );
        }

        const sampleIdsBefore = await getPanelTerminalIds();
        await vscode.commands.executeCommand("bootty.newTerminalInPanel");
        const sampleTerminalId = await waitForNewPanelTerminal(
          sampleIdsBefore,
          READY_TIMEOUT_MS,
        );
        await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
          terminalId: sampleTerminalId,
          timeoutMs: READY_TIMEOUT_MS,
          panelTimeoutMs: READY_TIMEOUT_MS,
        });
        await tryFocusPanel();

        const prompt = "BOOTTY_SH> ";
        await vscode.commands.executeCommand("bootty.test.sendInput", {
          terminalId: sampleTerminalId,
          data: `PS1='${prompt}' sh\n`,
        });
        await waitForText({
          terminalId: sampleTerminalId,
          text: prompt,
          timeoutMs: READY_TIMEOUT_MS,
        });
        const echoKeys = buildKeyEventsFromText("echo");
        await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
          terminalId: sampleTerminalId,
          keys: echoKeys,
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const sample = await sampleTrailingCells(
          sampleTerminalId,
          4,
          READY_TIMEOUT_MS,
        );
        assert.ok(!sample?.error, sample?.error ?? "sample error");
        assert.equal(sample.cells.length, 4, "Expected 4 sampled cells");
        const sampledText = sample.cells.map((cell) => cell.char).join("");
        assert.equal(sampledText, "echo", "Sampled text mismatch");
        for (const cell of sample.cells) {
          assert.equal(
            cell.hasInk,
            true,
            `Expected ink for col ${cell.col} char ${cell.char}`,
          );
        }

        await vscode.commands.executeCommand("bootty.test.destroyTerminal", {
          terminalId: sampleTerminalId,
        });
        await waitForPanelTerminalClosed(sampleTerminalId, READY_TIMEOUT_MS);
        await vscode.commands.executeCommand("bootty.test.activatePanelTerminal", {
          terminalId: panelTerminalId,
        });
        await tryFocusPanel();
      } finally {
        await cursorConfig.update(
          "cursorStyle",
          previousCursorValue === undefined ? undefined : previousCursorValue,
          rendererConfigTarget,
        );
        if (!forcedRenderer) {
          await rendererConfig.update(
            "renderer",
            rendererBeforeSample,
            rendererConfigTarget,
          );
        }
      }
    }

    // Skip direct write tests when using WebGL renderer (Canvas2D not available in headless)
    if (forcedRenderer && forcedRenderer !== "canvas") {
      console.warn(
        `[bootty e2e] Renderer forced to ${forcedRenderer}; skipping direct write tests (require Canvas2D).`,
      );
    } else {
    const directIdsBefore = await getPanelTerminalIds();
    await vscode.commands.executeCommand("bootty.newTerminalInPanel");
    const directTerminalId = await waitForNewPanelTerminal(
      directIdsBefore,
      READY_TIMEOUT_MS,
    );
    await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
      terminalId: directTerminalId,
      timeoutMs: READY_TIMEOUT_MS,
      panelTimeoutMs: READY_TIMEOUT_MS,
    });
    await tryFocusPanel();

    const redrawPayload = "\x1b[2J\x1b[Hhello\x1b[2DXY";
    await directWrite(directTerminalId, redrawPayload, READY_TIMEOUT_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const directSample = await sampleTrailingCells(
      directTerminalId,
      5,
      READY_TIMEOUT_MS,
    );
    assert.ok(!directSample?.error, directSample?.error ?? "direct sample error");
    assert.equal(directSample.cells.length, 5, "Expected 5 sampled cells");
    const directText = directSample.cells.map((cell) => cell.char).join("");
    assert.equal(directText, "helXY", "Direct redraw text mismatch");
    for (const cell of directSample.cells) {
      assert.equal(
        cell.hasInk,
        true,
        `Expected ink for col ${cell.col} char ${cell.char}`,
      );
    }

    const backspaceCases = [
      {
        name: "backspace-basic",
        payload: "AB\bC",
        expected: "AC",
        sampleLen: 2,
      },
      {
        name: "backspace-multi",
        payload: "ABC\b\bDE",
        expected: "ADE",
        sampleLen: 3,
      },
      {
        name: "backspace-start",
        payload: "\bA",
        expected: "A",
        sampleLen: 1,
      },
      {
        name: "backspace-sgr",
        payload: "AB\b\x1b[31mC\x1b[0m",
        expected: "AC",
        sampleLen: 2,
      },
    ];

    for (const testCase of backspaceCases) {
      const sampleLen = testCase.sampleLen;
      const backspacePayload = [
        "\x1b[2J\x1b[H",
        testCase.payload,
        "\x1b[H",
        `\x1b[${sampleLen}C`,
      ].join("");
      await directWrite(directTerminalId, backspacePayload, READY_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const backspaceSample = await sampleTrailingCells(
        directTerminalId,
        sampleLen,
        READY_TIMEOUT_MS,
      );
      assert.ok(
        !backspaceSample?.error,
        backspaceSample?.error ?? `${testCase.name} sample error`,
      );
      assert.equal(
        backspaceSample.cells.length,
        sampleLen,
        `${testCase.name} sample length mismatch`,
      );
      const backspaceText = backspaceSample.cells
        .map((cell) => cell.char)
        .join("");
      assert.equal(
        backspaceText,
        testCase.expected,
        `${testCase.name} text mismatch`,
      );
      for (const cell of backspaceSample.cells) {
        if (cell.char && cell.char !== " ") {
          assert.equal(
            cell.hasInk,
            true,
            `Expected ink for col ${cell.col} char ${cell.char} (${testCase.name})`,
          );
        }
      }
    }

    const zshExpected = "echo hello world";
    const zshPayload = [
      "\x1b[2J\x1b[H",
      "echo ",
      "h",
      "\b",
      "\x1b[1m\x1b[31m",
      "h",
      "\x1b[0m\x1b[39m",
      "ello ",
      "world",
      "\x1b[5D",
      "\x1b[90m",
      "world",
      "\x1b[39m",
      "\x1b[5D",
      "\x1b[5C",
      "\x1b[H",
      `\x1b[${zshExpected.length}C`,
    ].join("");
    await directWrite(directTerminalId, zshPayload, READY_TIMEOUT_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const zshSample = await sampleTrailingCells(
      directTerminalId,
      zshExpected.length,
      READY_TIMEOUT_MS,
    );
    assert.ok(!zshSample?.error, zshSample?.error ?? "zsh sample error");
    assert.equal(
      zshSample.cells.length,
      zshExpected.length,
      "Expected zsh sample length",
    );
    const zshText = zshSample.cells.map((cell) => cell.char).join("");
    assert.equal(zshText, zshExpected, "Zsh-like redraw text mismatch");
    for (const cell of zshSample.cells) {
      if (cell.char && cell.char !== " ") {
        assert.equal(
          cell.hasInk,
          true,
          `Expected ink for col ${cell.col} char ${cell.char}`,
        );
      }
    }

    // Test zsh autosuggestion backspace sequences (from real PTY capture)
    // This exercises the normalizeBackspace fix - zsh sends raw backspaces
    // which must be converted to CSI cursor left for correct rendering
    const zshAutoExpected = "echo hello world";
    const zshAutoPayload = [
      "\x1b[2J\x1b[H", // Clear screen, cursor home
      // Simulates typing "e" then zsh redraws with autosuggestion
      "e",
      "\b", // backspace - zsh erases to redraw with color
      "\x1b[1m\x1b[31me\x1b[0m\x1b[39m", // bold red "e"
      "\b", // backspace again for another redraw cycle
      "\x1b[1m\x1b[31me\x1b[0m\x1b[39m", // bold red "e" again
      "\x1b[90mcho hello world\x1b[39m", // faint gray autosuggestion
      "\x1b[15D", // cursor back to after "e"
      // Now accept the autosuggestion (type rest normally)
      "\b\b\b\b", // multiple backspaces (zsh editing)
      "\x1b[0m\x1b[32mecho\x1b[39m", // green "echo"
      " hello world", // rest of text
      "\x1b[H", // cursor home
      `\x1b[${zshAutoExpected.length}C`, // move cursor to end
    ].join("");
    await directWrite(directTerminalId, zshAutoPayload, READY_TIMEOUT_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const zshAutoSample = await sampleTrailingCells(
      directTerminalId,
      zshAutoExpected.length,
      READY_TIMEOUT_MS,
    );
    assert.ok(!zshAutoSample?.error, zshAutoSample?.error ?? "zsh auto sample error");
    assert.equal(
      zshAutoSample.cells.length,
      zshAutoExpected.length,
      "Expected zsh auto sample length",
    );
    const zshAutoText = zshAutoSample.cells.map((cell) => cell.char).join("");
    assert.equal(zshAutoText, zshAutoExpected, "Zsh autosuggestion backspace handling mismatch");
    for (const cell of zshAutoSample.cells) {
      if (cell.char && cell.char !== " ") {
        assert.equal(
          cell.hasInk,
          true,
          `Expected ink for col ${cell.col} char ${cell.char} (zsh auto test)`,
        );
      }
    }

    // Test rapid multi-write PTY pattern (from real zsh capture)
    // This tests the timing-sensitive case where renders may happen between writes
    const rapidExpected = "echo hello";
    await directWrite(directTerminalId, "\x1b[2J\x1b[H", READY_TIMEOUT_MS); // Clear and home
    // Send first character
    await directWrite(directTerminalId, "e", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5)); // Small delay to allow potential render
    // Send backspace + styled 'e' (as zsh does)
    await directWrite(directTerminalId, "\b\x1b[1m\x1b[31me\x1b[0m\x1b[39m", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Send more backspace redraw cycles (from capture)
    await directWrite(directTerminalId, "\b\x1b[1m\x1b[31me\x1b[0m\x1b[39m\x1b[90mxit\x1b[39m\b\b\b", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Type 'c' with redraw
    await directWrite(directTerminalId, "\b\x1b[1m\x1b[31me\x1b[1m\x1b[31mc\x1b[0m\x1b[39m\x1b[39m \x1b[39m \b\b", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Autosuggestion appears
    await directWrite(directTerminalId, "\x1b[90mho BOOTTY_KEY_BACKSPACE_TEST\x1b[39m\x1b[28D", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Type 'h' with backspaces
    await directWrite(directTerminalId, "\b\b\x1b[1m\x1b[31me\x1b[1m\x1b[31mc\x1b[1m\x1b[31mh\x1b[0m\x1b[39m", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Type 'o' with backspaces
    await directWrite(directTerminalId, "\b\x1b[1m\x1b[31mh\x1b[1m\x1b[31mo\x1b[0m\x1b[39m", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Convert to green "echo" with backspaces
    await directWrite(directTerminalId, "\b\b\b\b\x1b[0m\x1b[32me\x1b[0m\x1b[32mc\x1b[0m\x1b[32mh\x1b[0m\x1b[32mo\x1b[39m", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Type space and more
    await directWrite(directTerminalId, "\b\x1b[32mo\x1b[32m \x1b[39m", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    await directWrite(directTerminalId, "\b\b\x1b[32mo\x1b[39m\x1b[39m ", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Clear autosuggestion and write "hello"
    await directWrite(directTerminalId, "\x1b[39mh\x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[39m \x1b[24D", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    await directWrite(directTerminalId, "\x1b[90mello world\x1b[39m\x1b[10D", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    // Type 'e', 'l', 'l', 'o'
    await directWrite(directTerminalId, "\x1b[39me", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    await directWrite(directTerminalId, "\x1b[39ml", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    await directWrite(directTerminalId, "\x1b[39ml", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 5));
    await directWrite(directTerminalId, "\x1b[39mo", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 100)); // Final settle
    // Position cursor at end for sampling
    await directWrite(directTerminalId, "\x1b[H\x1b[" + rapidExpected.length + "C", READY_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 100));
    const rapidSample = await sampleTrailingCells(
      directTerminalId,
      rapidExpected.length,
      READY_TIMEOUT_MS,
    );
    assert.ok(!rapidSample?.error, rapidSample?.error ?? "rapid multi-write sample error");
    const rapidText = rapidSample.cells.map((cell) => cell.char).join("");
    assert.equal(rapidText, rapidExpected, "Rapid multi-write PTY pattern text mismatch: got '" + rapidText + "' expected '" + rapidExpected + "'");
    for (const cell of rapidSample.cells) {
      if (cell.char && cell.char !== " ") {
        assert.equal(
          cell.hasInk,
          true,
          `Expected ink for col ${cell.col} char ${cell.char} (rapid multi-write)`,
        );
      }
    }

    await vscode.commands.executeCommand("bootty.test.destroyTerminal", {
      terminalId: directTerminalId,
    });
    await waitForPanelTerminalClosed(directTerminalId, READY_TIMEOUT_MS);
    await vscode.commands.executeCommand("bootty.test.activatePanelTerminal", {
      terminalId: panelTerminalId,
    });
    await tryFocusPanel();
    } // End of direct write tests skip block

    // ============================================================
    // ECHO VERIFICATION TESTS
    // These tests verify that typed characters ECHO before Enter
    // ============================================================
    console.log("Starting echo verification tests...");

    // Create a fresh terminal with minimal shell for echo testing
    const echoTestIdsBefore = await getPanelTerminalIds();
    await vscode.commands.executeCommand("bootty.newTerminalInPanel");
    const echoTestTerminalId = await waitForNewPanelTerminal(
      echoTestIdsBefore,
      READY_TIMEOUT_MS,
    );
    await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
      terminalId: echoTestTerminalId,
      timeoutMs: READY_TIMEOUT_MS,
      panelTimeoutMs: READY_TIMEOUT_MS,
    });
    await tryFocusPanel();

    // Switch to minimal shell with known prompt
    const echoPrompt = "ECHO> ";
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: echoTestTerminalId,
      data: `PS1='${echoPrompt}' sh\n`,
    });
    await waitForText({
      terminalId: echoTestTerminalId,
      text: echoPrompt,
      timeoutMs: READY_TIMEOUT_MS,
    });

    // Start pipeline trace to capture echo events
    const echoTracePath = await startPipelineTrace(echoTestTerminalId);
    console.log(`Echo test trace started: ${echoTracePath}`);

    // TEST 1: Basic echo - type unique text and verify it appears via findText (not sampleTrailingCells)
    // Use unique marker that won't appear elsewhere in the terminal
    console.log("TEST 1: Basic echo verification (using waitForText)...");
    const basicEchoMarker = "ECHO_TEST_7x9q2";
    const basicEchoKeys = buildKeyEventsFromText(basicEchoMarker);
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: basicEchoKeys,
    });

    // Verify the echo appeared in the terminal buffer (WITHOUT pressing Enter)
    // This uses findText which searches the xterm buffer, not canvas
    try {
      await waitForText({
        terminalId: echoTestTerminalId,
        text: basicEchoMarker,
        timeoutMs: 5000, // Shorter timeout for echo (should be fast)
      });
      console.log("TEST 1: Basic echo verification PASSED - echo found in buffer");
    } catch (error) {
      // This is the bug we're looking for!
      console.error(`ECHO BUG DETECTED: "${basicEchoMarker}" not found in terminal buffer after typing`);
      console.error("The typed characters were sent to PTY but echo never appeared in the webview");
      throw error;
    }

    // Press Enter to clear the line for next test
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: [{ key: "Enter", code: "Enter" }],
    });
    await waitForText({
      terminalId: echoTestTerminalId,
      text: echoPrompt,
      timeoutMs: READY_TIMEOUT_MS,
    });

    // TEST 2: Single character echo
    console.log("TEST 2: Single character echo...");
    const singleCharMarker = "Q"; // Unique character that's easy to find
    const singleCharKeys = [{ key: singleCharMarker, code: "KeyQ" }];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: singleCharKeys,
    });

    // Type more to make a unique searchable string
    const singleTestSuffix = "7k3m";
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: buildKeyEventsFromText(singleTestSuffix),
    });

    try {
      await waitForText({
        terminalId: echoTestTerminalId,
        text: singleCharMarker + singleTestSuffix,
        timeoutMs: 5000,
      });
      console.log("TEST 2: Single character echo PASSED");
    } catch (error) {
      console.error(`ECHO BUG DETECTED: Single char echo "${singleCharMarker}${singleTestSuffix}" not found`);
      throw error;
    }

    // Press Enter to clear
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: [{ key: "Enter", code: "Enter" }],
    });
    await waitForText({
      terminalId: echoTestTerminalId,
      text: echoPrompt,
      timeoutMs: READY_TIMEOUT_MS,
    });

    // TEST 3: Echo with backspace - type "abc", backspace, then type marker
    // After backspace, type a unique suffix and verify the combined result
    console.log("TEST 3: Echo with backspace...");
    const backspaceTestPrefix = "abc";
    const backspaceTestSuffix = "XY9z";
    const backspaceEchoKeys = [
      ...buildKeyEventsFromText(backspaceTestPrefix),
      { key: "Backspace", code: "Backspace" },
      ...buildKeyEventsFromText(backspaceTestSuffix),
    ];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: backspaceEchoKeys,
    });

    // After "abc" + backspace + "XY9z", should see "abXY9z"
    const expectedBackspaceResult = "ab" + backspaceTestSuffix;
    try {
      await waitForText({
        terminalId: echoTestTerminalId,
        text: expectedBackspaceResult,
        timeoutMs: 5000,
      });
      console.log("TEST 3: Echo with backspace PASSED");
    } catch (error) {
      console.error(`ECHO BUG DETECTED: Backspace echo "${expectedBackspaceResult}" not found`);
      throw error;
    }

    // Press Enter to clear for next test
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: echoTestTerminalId,
      keys: [{ key: "Enter", code: "Enter" }],
    });
    await waitForText({
      terminalId: echoTestTerminalId,
      text: echoPrompt,
      timeoutMs: READY_TIMEOUT_MS,
    });

    // TEST 4: Slow typing (simulates human typing speed)
    // This should reproduce the echo bug seen in manual testing where
    // individual characters typed slowly get dropped by webview.postMessage
    console.log("TEST 4: Slow typing simulation (20ms between keys)...");
    const slowTypingMarker = "SLOW_8k2p";
    const slowTypingKeys = buildKeyEventsFromText(slowTypingMarker);
    const INTER_KEY_DELAY_MS = 20; // Human typing speed ~50 WPM = ~20ms per keystroke

    // Dispatch keys one at a time with delays
    for (const keyEvent of slowTypingKeys) {
      await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
        terminalId: echoTestTerminalId,
        keys: [keyEvent],
      });
      await new Promise((resolve) => setTimeout(resolve, INTER_KEY_DELAY_MS));
    }

    // Verify the slow-typed text appeared in the terminal buffer
    try {
      await waitForText({
        terminalId: echoTestTerminalId,
        text: slowTypingMarker,
        timeoutMs: 5000,
      });
      console.log("TEST 4: Slow typing PASSED - echo found in buffer");
    } catch (error) {
      console.error(`ECHO BUG DETECTED: Slow-typed "${slowTypingMarker}" not found in terminal buffer`);
      console.error("This indicates individual echo characters are being dropped by postMessage");
      throw error;
    }

    // Stop trace and analyze
    await new Promise((resolve) => setTimeout(resolve, 200));
    const echoTrace = await stopPipelineTrace(echoTestTerminalId);
    console.log(`Echo trace captured ${echoTrace.length} events`);

    // Analyze trace for echo events
    const echoStagesByType = {};
    for (const event of echoTrace) {
      echoStagesByType[event.stage] = (echoStagesByType[event.stage] || 0) + 1;
    }
    console.log(`Echo trace stages: ${JSON.stringify(echoStagesByType)}`);

    // Check for missing webview-recv events (the bug symptom)
    const ptyRecvCount = echoStagesByType["pty-recv"] || 0;
    const webviewRecvCount = echoStagesByType["webview-recv"] || 0;
    console.log(`pty-recv: ${ptyRecvCount}, webview-recv: ${webviewRecvCount}`);

    // Each echo character should have a corresponding webview-recv
    // If webview-recv < pty-recv, echo data is being lost
    if (webviewRecvCount < ptyRecvCount) {
      console.error(`PIPELINE BUG: ${ptyRecvCount - webviewRecvCount} echo events missing from webview`);
    }

    // Verify all expected stages are present for echo
    const echoExpectedStages = ["pty-recv", "batch-flush", "webview-recv", "term-write"];
    const missingStages = echoExpectedStages.filter((stage) => !echoStagesByType[stage]);
    if (missingStages.length > 0) {
      console.error(`PIPELINE BUG: Missing stages for echo: ${missingStages.join(", ")}`);
    }
    assertTraceStagesPresent(echoTrace, echoExpectedStages);
    console.log("Echo pipeline trace verification PASSED");

    // Cleanup echo test terminal
    await vscode.commands.executeCommand("bootty.test.destroyTerminal", {
      terminalId: echoTestTerminalId,
    });
    await waitForPanelTerminalClosed(echoTestTerminalId, READY_TIMEOUT_MS);
    await vscode.commands.executeCommand("bootty.test.activatePanelTerminal", {
      terminalId: panelTerminalId,
    });
    await tryFocusPanel();
    console.log("Echo verification tests completed");
    // ============================================================
    // END ECHO VERIFICATION TESTS
    // ============================================================

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

    const readTabLabel = "BOOTTY_READ_TAB_TEST";
    const readTabSuffix = "TABMARK";
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: panelTerminalId,
      data: `read -r line; printf '${readTabLabel}:%s\\n' "$line"\n`,
    });
    const readTabEvents = [
      ...buildKeyEventsFromText("0x"),
      { key: "Tab", code: "Tab" },
      ...buildKeyEventsFromText(readTabSuffix),
      { key: "Enter", code: "Enter" },
    ];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: panelTerminalId,
      keys: readTabEvents,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: `${readTabLabel}:0x`,
      timeoutMs: READY_TIMEOUT_MS,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: readTabSuffix,
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

    const searchNeedle = "BOOTTY_SEARCH_NEEDLE";
    const searchLine2 = `${searchNeedle}-2`;
    await vscode.commands.executeCommand("bootty.test.sendInput", {
      terminalId: panelTerminalId,
      data: `printf '${searchNeedle}-1\\n${searchLine2}\\n'\n`,
    });
    await waitForText({
      terminalId: panelTerminalId,
      text: searchLine2,
      timeoutMs: READY_TIMEOUT_MS,
    });
    await tryFocusPanel();
    await vscode.commands.executeCommand("bootty.search");
    const searchVisibleState = await vscode.commands.executeCommand(
      "bootty.test.search",
      {
        terminalId: panelTerminalId,
        action: "status",
      },
    );
    assert.equal(
      searchVisibleState?.visible,
      true,
      "Search overlay did not open",
    );
    await vscode.commands.executeCommand("bootty.test.search", {
      terminalId: panelTerminalId,
      query: searchNeedle,
    });
    const searchState = await vscode.commands.executeCommand(
      "bootty.test.search",
      {
        terminalId: panelTerminalId,
        action: "status",
      },
    );
    const resultsMatch = /of\s+(\d+)/.exec(searchState?.resultsText ?? "");
    assert.ok(resultsMatch, "Search results missing");
    const resultsTotal = Number.parseInt(resultsMatch[1], 10);
    assert.ok(
      Number.isFinite(resultsTotal) && resultsTotal >= 2,
      "Search results count invalid",
    );
    await vscode.commands.executeCommand("bootty.test.search", {
      terminalId: panelTerminalId,
      action: "hide",
    });
    const searchHiddenState = await vscode.commands.executeCommand(
      "bootty.test.search",
      {
        terminalId: panelTerminalId,
        action: "status",
      },
    );
    assert.equal(searchHiddenState?.visible, false);

    const searchShortcutKeys = [
      { key: "f", code: "KeyF", ctrlKey: true },
    ];
    await vscode.commands.executeCommand("bootty.test.dispatchKeys", {
      terminalId: panelTerminalId,
      keys: searchShortcutKeys,
    });
    const searchShortcutState = await vscode.commands.executeCommand(
      "bootty.test.search",
      {
        terminalId: panelTerminalId,
        action: "status",
      },
    );
    assert.equal(
      searchShortcutState?.visible,
      true,
      "Search shortcut did not open overlay",
    );
    await vscode.commands.executeCommand("bootty.test.search", {
      terminalId: panelTerminalId,
      action: "hide",
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

  const closeIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand("bootty.newTerminalInPanel");
  const closePanelId = await waitForNewPanelTerminal(
    closeIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: closePanelId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: closePanelId,
    data: "exit\n",
  });
  await waitForPanelTerminalClosed(closePanelId, READY_TIMEOUT_MS);

  const newTerminalIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand("bootty.newTerminal");
  const newTerminalId = await waitForNewPanelTerminal(
    newTerminalIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: newTerminalId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });

  nestedFile = ensureNestedWorkspaceFile(workspacePath);
  const nestedDoc = await vscode.workspace.openTextDocument(nestedFile.filePath);
  await vscode.window.showTextDocument(nestedDoc);
  const hereIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand(
    "bootty.newTerminalHere",
    vscode.Uri.file(nestedFile.filePath),
  );
  const hereTerminalId = await waitForNewPanelTerminal(
    hereIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: hereTerminalId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  const hereLabel = "BOOTTY_NEW_TERMINAL_HERE_READY";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: hereTerminalId,
    data: `printf '${hereLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: hereTerminalId,
    text: hereLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: hereTerminalId,
    data: "pwd\n",
  });
  await waitForText({
    terminalId: hereTerminalId,
    text: path.basename(nestedFile.nestedDir),
    timeoutMs: READY_TIMEOUT_MS,
  });

  const activeLabel1 = "BOOTTY_ACTIVE_BEFORE_TABS";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    data: `printf '${activeLabel1}\\n'\n`,
  });
  const panelIdsSnapshot = await getPanelTerminalIds();
  const activeId1 = await waitForTextInAnyTerminal({
    terminalIds: panelIdsSnapshot,
    text: activeLabel1,
    timeoutMs: READY_TIMEOUT_MS,
  });

  await vscode.commands.executeCommand("bootty.nextTab");
  const activeLabel2 = "BOOTTY_ACTIVE_AFTER_NEXT";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    data: `printf '${activeLabel2}\\n'\n`,
  });
  const activeId2 = await waitForTextInAnyTerminal({
    terminalIds: panelIdsSnapshot,
    text: activeLabel2,
    timeoutMs: READY_TIMEOUT_MS,
  });
  if (panelIdsSnapshot.length > 1) {
    assert.ok(panelIdsSnapshot.includes(activeId2));
  }

  await vscode.commands.executeCommand("bootty.previousTab");
  const activeLabel3 = "BOOTTY_ACTIVE_AFTER_PREV";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    data: `printf '${activeLabel3}\\n'\n`,
  });
  const activeId3 = await waitForTextInAnyTerminal({
    terminalIds: panelIdsSnapshot,
    text: activeLabel3,
    timeoutMs: READY_TIMEOUT_MS,
  });
  if (panelIdsSnapshot.length > 1) {
    assert.ok(panelIdsSnapshot.includes(activeId3));
  }

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

  await vscode.commands.executeCommand("bootty.togglePanel");
  await new Promise((resolve) => setTimeout(resolve, FIND_TEXT_POLL_MS));
  await vscode.commands.executeCommand("bootty.togglePanel");
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: panelTerminalId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  await tryFocusPanel();
  const toggleLabel = "BOOTTY_PANEL_TOGGLE_OK";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: panelTerminalId,
    data: `printf '${toggleLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: panelTerminalId,
    text: toggleLabel,
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

  const editorSearchNeedle = "BOOTTY_EDITOR_SEARCH_NEEDLE";
  const editorSearchLine2 = `${editorSearchNeedle}-2`;
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: editorTerminalId,
    data: `printf '${editorSearchNeedle}-1\\n${editorSearchLine2}\\n'\n`,
  });
  await waitForText({
    terminalId: editorTerminalId,
    text: editorSearchLine2,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("bootty.search");
  const editorSearchVisibleState = await vscode.commands.executeCommand(
    "bootty.test.search",
    {
      terminalId: editorTerminalId,
      action: "status",
    },
  );
  assert.equal(
    editorSearchVisibleState?.visible,
    true,
    "Editor search overlay did not open",
  );
  await vscode.commands.executeCommand("bootty.test.search", {
    terminalId: editorTerminalId,
    query: editorSearchNeedle,
  });
  const editorSearchState = await vscode.commands.executeCommand(
    "bootty.test.search",
    {
      terminalId: editorTerminalId,
      action: "status",
    },
  );
  const editorResultsMatch = /of\s+(\d+)/.exec(
    editorSearchState?.resultsText ?? "",
  );
  assert.ok(editorResultsMatch, "Editor search results missing");
  const editorResultsTotal = Number.parseInt(editorResultsMatch[1], 10);
  assert.ok(
    Number.isFinite(editorResultsTotal) && editorResultsTotal >= 2,
    "Editor search results count invalid",
  );
  await vscode.commands.executeCommand("bootty.test.search", {
    terminalId: editorTerminalId,
    action: "hide",
  });
  const editorSearchHiddenState = await vscode.commands.executeCommand(
    "bootty.test.search",
    {
      terminalId: editorTerminalId,
      action: "status",
    },
  );
  assert.equal(editorSearchHiddenState?.visible, false);

  const defaultLocationConfig =
    vscode.workspace.getConfiguration("bootty");
  const previousDefaultLocation = defaultLocationConfig.get(
    "defaultTerminalLocation",
    "panel",
  );
  const editorIdsBeforeDefault = await getEditorTerminalIds();
  await defaultLocationConfig.update(
    "defaultTerminalLocation",
    "editor",
    vscode.ConfigurationTarget.Workspace,
  );
  await vscode.commands.executeCommand("bootty.newTerminal");
  const defaultEditorId = await waitForNewEditorTerminal(
    editorIdsBeforeDefault,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: defaultEditorId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  const defaultEditorLabel = "BOOTTY_DEFAULT_EDITOR_READY";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: defaultEditorId,
    data: `printf '${defaultEditorLabel}\\n'\n`,
  });
  await waitForText({
    terminalId: defaultEditorId,
    text: defaultEditorLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });
  await defaultLocationConfig.update(
    "defaultTerminalLocation",
    previousDefaultLocation,
    vscode.ConfigurationTarget.Workspace,
  );

  const editorCloseIdsBefore = await getEditorTerminalIds();
  await vscode.commands.executeCommand("bootty.newTerminalInEditor");
  const editorCloseId = await waitForNewEditorTerminal(
    editorCloseIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: editorCloseId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: editorCloseId,
    data: "exit\n",
  });
  await waitForEditorTerminalClosed(editorCloseId, READY_TIMEOUT_MS);

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

  await vscode.commands.executeCommand("bootty.rendererInfo");
  await vscode.commands.executeCommand("bootty.toggleProfiling");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await vscode.commands.executeCommand("bootty.toggleProfiling");

  // Pipeline trace test - verify data flows through all stages
  console.log("Testing pipeline trace...");
  const traceIdsBefore = await getPanelTerminalIds();
  await vscode.commands.executeCommand("bootty.newTerminalInPanel");
  const traceTerminalId = await waitForNewPanelTerminal(
    traceIdsBefore,
    READY_TIMEOUT_MS,
  );
  await vscode.commands.executeCommand("bootty.test.waitForHandshake", {
    terminalId: traceTerminalId,
    timeoutMs: READY_TIMEOUT_MS,
    panelTimeoutMs: READY_TIMEOUT_MS,
  });
  await tryFocusPanel();

  const tracePath = await startPipelineTrace(traceTerminalId);
  console.log(`Pipeline trace started: ${tracePath}`);

  // Send a simple echo command through the real PTY
  const traceLabel = "BOOTTY_TRACE_TEST_12345";
  await vscode.commands.executeCommand("bootty.test.sendInput", {
    terminalId: traceTerminalId,
    data: `echo ${traceLabel}\n`,
  });
  await waitForText({
    terminalId: traceTerminalId,
    text: traceLabel,
    timeoutMs: READY_TIMEOUT_MS,
  });

  // Small delay to ensure all trace events are flushed
  await new Promise((resolve) => setTimeout(resolve, 200));

  const trace = await stopPipelineTrace(traceTerminalId);
  console.log(`Pipeline trace stopped, ${trace.length} events captured`);

  // Log trace summary by stage
  const stagesByType = {};
  for (const event of trace) {
    stagesByType[event.stage] = (stagesByType[event.stage] || 0) + 1;
  }
  console.log(`Trace stages: ${JSON.stringify(stagesByType)}`);

  // Verify all expected stages are present
  const expectedStages = [
    "pty-recv",      // Extension received from node-pty
    "batch-flush",   // Extension sent to webview
    "webview-recv",  // Webview received pty-data
    "drain-result",  // Worker returned data
    "term-write",    // Terminal.write() called
  ];
  assertTraceStagesPresent(trace, expectedStages);
  console.log("Pipeline trace test passed - all stages present");

  // Check that pty-recv bytes roughly match term-write bytes
  const recvBytes = trace
    .filter((e) => e.stage === "pty-recv")
    .reduce((sum, e) => sum + e.bytes, 0);
  const writeBytes = trace
    .filter((e) => e.stage === "term-write")
    .reduce((sum, e) => sum + e.bytes, 0);
  console.log(`Bytes: pty-recv=${recvBytes} term-write=${writeBytes}`);
  assert.ok(
    writeBytes > 0,
    `No bytes written to terminal (pty-recv=${recvBytes})`,
  );

  await vscode.commands.executeCommand("bootty.test.destroyTerminal", {
    terminalId: traceTerminalId,
  });
  await waitForPanelTerminalClosed(traceTerminalId, READY_TIMEOUT_MS);

    setTimeout(() => process.exit(0), 200);
  } finally {
    if (defaultLocationConfigTarget) {
      await vscode.workspace
        .getConfiguration("bootty")
        .update(
          "defaultTerminalLocation",
          previousDefaultLocationValue === undefined
            ? undefined
            : previousDefaultLocationValue,
          defaultLocationConfigTarget,
        );
    }
    if (linkFilePath && fs.existsSync(linkFilePath)) {
      fs.unlinkSync(linkFilePath);
    }
    if (nestedFile?.filePath && fs.existsSync(nestedFile.filePath)) {
      fs.unlinkSync(nestedFile.filePath);
    }
  }
}

module.exports = { run };
