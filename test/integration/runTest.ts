import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // out/integration/runTest.js → リポジトリのルート
  const root = path.resolve(__dirname, '..', '..');
  // テスト中に設定や dts を書き換えるので、ワークスペースは一時ディレクトリに写す
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dtv-it-'));
  fs.cpSync(path.join(root, 'test', 'fixtures', 'workspace'), ws, { recursive: true });
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { DTV_IT_WORKSPACE: ws },
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
