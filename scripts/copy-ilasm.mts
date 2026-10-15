#!/usr/bin/env node
// Copies the ilasm binaries of every supported platform next to the published engine, so the ILASM
// round-trip works straight after installing the extension instead of asking the user to provide an
// assembler. The binaries come from the NuGet cache of the runtime packs the engine references.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'out', 'engine', 'ilasm');
const rids = ['linux-x64', 'linux-arm64', 'osx-x64', 'osx-arm64', 'win-x64'];
const packages = process.env.NUGET_PACKAGES ?? path.join(os.homedir(), '.nuget', 'packages');

let copied = 0;

/** Compares two package versions so that 10.0.12 sorts above 9.0.0. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (Number(a[index]) || 0) - (Number(b[index]) || 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

for (const rid of rids) {
  const executable = rid === 'win-x64' ? 'ilasm.exe' : 'ilasm';
  const packageDirectory = path.join(packages, `runtime.${rid}.microsoft.netcore.ilasm`);
  if (!fs.existsSync(packageDirectory)) {
    console.log(`  ${rid}: not in the package cache, skipped`);
    continue;
  }

  // The newest version in the cache is what gets shipped, which needs a numeric comparison: string
  // order puts 9.0.0 after 10.0.12 and would silently bundle the older assembler.
  const version = fs
    .readdirSync(packageDirectory)
    .filter((entry) => fs.existsSync(path.join(packageDirectory, entry, 'runtimes', rid, 'native', executable)))
    .sort(compareVersions)
    .at(-1);

  if (!version) {
    console.log(`  ${rid}: the package has no ${executable}, skipped`);
    continue;
  }

  const source = path.join(packageDirectory, version, 'runtimes', rid, 'native', executable);
  const destinationDirectory = path.join(target, rid);
  fs.mkdirSync(destinationDirectory, { recursive: true });

  const destination = path.join(destinationDirectory, executable);
  fs.copyFileSync(source, destination);
  if (rid !== 'win-x64') {
    fs.chmodSync(destination, 0o755);
  }

  console.log(`  ${rid}: ${executable} ${version} (${Math.round(fs.statSync(destination).size / 1024)} KB)`);
  copied++;
}

if (copied === 0) {
  console.error('no ilasm binary was found; the ILASM round-trip will need "ilasmDotnet.ilasmPath"');
} else {
  console.log(`copied ${copied} ilasm binaries to out/engine/ilasm`);
}
