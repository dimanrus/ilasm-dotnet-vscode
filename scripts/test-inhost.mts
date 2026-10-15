#!/usr/bin/env node
// Runs scripts/inhost/index.ts inside a real VS Code extension host, using an isolated profile.
//
//   node scripts/test-inhost.mts                     # development host: loads the repo folder
//   node scripts/test-inhost.mts --vsix <file.vsix>  # installs the packaged extension and tests it
//
// VS Code detaches the CLI, so the result is read back from the window's renderer log.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureProject = path.join(root, 'test', 'fixtures', 'SampleLib', 'SampleLib.csproj');
const liveProject = path.join(root, 'test', 'fixtures', 'LiveTarget', 'LiveTarget.csproj');
const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-host-'));
const userDataDirectory = path.join(profileDirectory, 'user-data');
const extensionsDirectory = path.join(profileDirectory, 'extensions');
const timeoutMs = Number(process.env.IL_VIEWER_HOST_TIMEOUT ?? 240_000);

function parseArguments(argv: string[]): { vsix: string | undefined } {
  const vsixIndex = argv.indexOf('--vsix');
  return { vsix: vsixIndex >= 0 ? argv[vsixIndex + 1] : undefined };
}

function buildFixture() {
  console.log('building the fixture library...');
  const result = spawnSync('dotnet', ['build', fixtureProject, '-c', 'Debug', '-v', 'q', '--nologo'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`fixture build failed:\n${result.stdout}\n${result.stderr}`);
  }

  // The live route attaches to a process, so the long running target has to exist in release form.
  console.log('building the live target...');
  const live = spawnSync('dotnet', ['build', liveProject, '-c', 'Release', '-v', 'q', '--nologo'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  if (live.status !== 0) {
    throw new Error(`live target build failed:\n${live.stdout}\n${live.stderr}`);
  }
}

/** Installs the VSIX into the isolated profile and returns what it registered. */
function installVsix(vsixPath: string): string[] {
  console.log(`installing ${path.basename(vsixPath)} into the isolated profile...`);
  const result = spawnSync(
    'code',
    [
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
      '--install-extension',
      vsixPath,
      '--force',
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(`installing the VSIX failed:\n${result.stdout}\n${result.stderr}`);
  }

  const installed = fs.existsSync(extensionsDirectory) ? fs.readdirSync(extensionsDirectory) : [];
  console.log(`installed into ${extensionsDirectory}: ${installed.join(', ') || '(nothing)'}`);
  return installed;
}

/** Prints whatever the run left behind, so a missing report can be diagnosed. */
function dumpDiagnostics() {
  const logPath = findRendererLog();
  if (!logPath) {
    console.error('no renderer log was produced; VS Code may not have started.');
    return;
  }

  console.error(`\n--- tail of ${logPath} ---`);
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  for (const line of lines.slice(-40)) {
    console.error(line);
  }

  const hostLog = path.join(path.dirname(logPath), 'exthost', 'exthost.log');
  if (fs.existsSync(hostLog)) {
    const interesting = fs
      .readFileSync(hostLog, 'utf8')
      .split('\n')
      .filter((line) => /\[error\]|\[warning\]|ilasm-dotnet/i.test(line))
      .slice(-30);

    if (interesting.length > 0) {
      console.error(`\n--- extension host log (${hostLog}) ---`);
      for (const line of interesting) {
        console.error(line);
      }
    }
  }
}

/**
 * Extracts the VSIX so its contents can be loaded by a development host. VS Code only runs
 * --extensionTestsPath for a development host, so an installed extension cannot be tested
 * directly; extracting verifies the packaged files themselves, while installVsix proves the
 * package installs.
 */
function extractVsix(vsixPath: string): string {
  const target = path.join(profileDirectory, 'extracted');
  fs.mkdirSync(target, { recursive: true });

  const result = spawnSync('unzip', ['-q', '-o', vsixPath, '-d', target], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`extracting the VSIX failed:\n${result.stdout}\n${result.stderr}`);
  }

  const extensionRoot = path.join(target, 'extension');
  if (!fs.existsSync(path.join(extensionRoot, 'package.json'))) {
    throw new Error(`the VSIX has no extension/package.json (looked in ${extensionRoot})`);
  }

  console.log(`extracted the packaged files to ${extensionRoot}`);
  return extensionRoot;
}

/**
 * Closes the window the test opened. The run leaves a real VS Code using the throwaway profile, and
 * leaving it behind would litter the desktop and hold on to a deleted profile directory.
 */
function closeWindow() {
  const listing = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  if (listing.status !== 0 || !listing.stdout) {
    return;
  }

  for (const line of listing.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, pid, args] = match;
    if (!args.includes(profileDirectory) || args.includes('ps -eo')) {
      continue;
    }

    // Only the main process is signalled; it takes its children down with it.
    if (args.includes('crashpad_handler') || args.includes('--type=')) {
      continue;
    }

    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`closed the test window (pid ${pid})`);
    } catch {
      // The process already exited.
    }
  }
}

function findRendererLog() {
  const logsRoot = path.join(userDataDirectory, 'logs');
  if (!fs.existsSync(logsRoot)) {
    return undefined;
  }

  const candidates = [];
  for (const session of fs.readdirSync(logsRoot)) {
    const sessionRoot = path.join(logsRoot, session);
    for (const entry of fs.readdirSync(sessionRoot)) {
      const candidate = path.join(sessionRoot, entry, 'renderer.log');
      if (entry.startsWith('window') && fs.existsSync(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates.sort().pop();
}

function readReport() {
  const logPath = findRendererLog();
  if (!logPath) {
    return undefined;
  }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const resultIndex = lines.findIndex((line) => /in-host checks passed/.test(line));
  if (resultIndex < 0) {
    return undefined;
  }

  const match = /(\d+)\/(\d+) in-host checks passed/.exec(lines[resultIndex]);
  if (!match) {
    return undefined;
  }

  const checks = lines
    .slice(0, resultIndex)
    .filter((line) => /\[info\]\s+(ok|FAIL)\s+/.test(line))
    .map((line) => line.replace(/^.*\[info\]\s+/, ''));

  return { passed: Number(match[1]), total: Number(match[2]), checks, logPath };
}

async function main() {
  const { vsix } = parseArguments(process.argv.slice(2));
  const resolvedVsix = vsix ? path.resolve(vsix) : undefined;

  if (resolvedVsix && !fs.existsSync(resolvedVsix)) {
    throw new Error(`the VSIX was not found: ${resolvedVsix}`);
  }

  if (!resolvedVsix && !fs.existsSync(path.join(root, 'out', 'extension.js'))) {
    throw new Error('out/extension.js is missing; run "npm run compile" first.');
  }

  buildFixture();

  const args = [
    `--user-data-dir=${userDataDirectory}`,
    `--extensions-dir=${extensionsDirectory}`,
    `--extensionTestsPath=${path.join(root, 'out', 'inhost')}`,
    '--disable-telemetry',
    '--disable-workspace-trust',
    '--disable-updates',
  ];

  if (resolvedVsix) {
    installVsix(resolvedVsix);
    args.push(`--extensionDevelopmentPath=${extractVsix(resolvedVsix)}`);
    console.log('launching VS Code against the packaged files...');
  } else {
    args.push(`--extensionDevelopmentPath=${root}`);
    console.log('launching VS Code with an isolated development profile (a window will open)...');
  }

  args.push('--new-window', root);

  const child = spawn('code', args, { stdio: 'ignore', detached: true });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let report;
  while (Date.now() < deadline) {
    report = readReport();
    if (report) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  closeWindow();

  if (!report) {
    console.error(`the in-host test did not finish within ${timeoutMs} ms`);
    dumpDiagnostics();
    process.exitCode = 1;
    return;
  }

  for (const line of report.checks) {
    console.log(`  ${line}`);
  }

  console.log(`\n${report.passed}/${report.total} in-host checks passed`);

  if (report.passed !== report.total) {
    console.error(`failures are listed above; full log: ${report.logPath}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Keep the profile on failure so its logs can be inspected.
    if (process.exitCode === 1) {
      console.error(`\nprofile kept for inspection: ${profileDirectory}`);
      return;
    }

    // The window is signalled just before this runs and keeps writing while it shuts down, so wait
    // for it to finish and only then remove the directory. The wait has to be awaited, otherwise the
    // process exits first and the profile is left behind.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    try {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
    } catch {
      console.error(`could not remove ${profileDirectory}`);
    }
  });
