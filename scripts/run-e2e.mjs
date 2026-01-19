import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionDevelopmentPath = path.resolve(__dirname, "..");
const extensionTestsPath = path.resolve(__dirname, "../test/e2e/runner.js");
const workspacePath = path.resolve(__dirname, "../test/e2e/workspace");
const userDataDir = path.resolve(__dirname, `../.vscode-test/e2e-user-data-${Date.now()}`);

async function main() {
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, "--disable-workspace-trust", `--user-data-dir=${userDataDir}`],
      extensionTestsEnv: {
        ...process.env,
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
}

await main();
