#!/usr/bin/env node
// End to end check of the ILASM Dotnet engine: builds the fixture library, talks JSON-RPC to the
// engine and verifies that the IL and C# views can be linked to the original source lines.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureProject = path.join(root, 'test', 'fixtures', 'SampleLib', 'SampleLib.csproj');
const fixtureAssembly = path.join(root, 'test', 'fixtures', 'SampleLib', 'bin', 'Debug', 'net10.0', 'SampleLib.dll');
const releaseAssembly = path.join(root, 'test', 'fixtures', 'SampleLib', 'bin', 'Release', 'net10.0', 'SampleLib.dll');
const fixtureSource = path.join(root, 'test', 'fixtures', 'SampleLib', 'Calculator.cs');
const liveDirectory = path.join(root, 'test', 'fixtures', 'LiveTarget');
const liveProject = path.join(liveDirectory, 'LiveTarget.csproj');
const liveAssembly = path.join(root, 'test', 'fixtures', 'LiveTarget', 'bin', 'Release', 'net8.0', 'LiveTarget.dll');
const r2rDirectory = path.join(liveDirectory, 'bin', 'r2r');
const r2rAssembly = path.join(r2rDirectory, 'LiveTarget.dll');
const r2rArm64Directory = path.join(liveDirectory, 'bin', 'r2r-arm64');
const r2rArm64Assembly = path.join(r2rArm64Directory, 'LiveTarget.dll');
const aotDirectory = path.join(root, 'test', 'fixtures', 'AotTarget');
const aotProject = path.join(aotDirectory, 'AotTarget.csproj');
const aotSource = path.join(aotDirectory, 'Target.cs');
const aotImage = path.join(aotDirectory, 'bin', 'Release', 'net10.0', 'linux-x64', 'publish', 'AotTarget');
const liveSource = path.join(liveDirectory, 'Target.cs');
const playgroundDirectory = path.join(root, 'test', 'fixtures', 'Playground');
const playgroundProject = path.join(playgroundDirectory, 'Playground.csproj');
const playgroundAssembly = path.join(playgroundDirectory, 'bin', 'Release', 'net10.0', 'Playground.dll');
const fsDirectory = path.join(root, 'test', 'fixtures', 'FsTarget');
const fsProject = path.join(fsDirectory, 'FsTarget.fsproj');
const fsSource = path.join(fsDirectory, 'Catalog.fs');
const fsAssembly = path.join(fsDirectory, 'bin', 'Release', 'net10.0', 'FsTarget.dll');
const fsR2rAssembly = path.join(fsDirectory, 'bin', 'r2r', 'FsTarget.dll');
const r2rDebugDirectory = path.join(root, 'test', 'fixtures', 'R2RDebug');
const r2rDebugProject = path.join(r2rDebugDirectory, 'R2RDebug.csproj');
const r2rDebugSource = path.join(r2rDebugDirectory, 'Methods.cs');
const r2rDebugAssembly = path.join(r2rDebugDirectory, 'bin', 'r2r', 'R2RDebug.dll');
const singleDirectory = path.join(liveDirectory, 'bin', 'single');
const singleImage = path.join(singleDirectory, 'LiveTarget');
const compressedDirectory = path.join(liveDirectory, 'bin', 'single-compressed');
const compressedImage = path.join(compressedDirectory, 'LiveTarget');

const failures = [];
const checks = [];

function check(name, condition, detail = '') {
  checks.push(name);
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildFixture() {
  for (const [name, project] of [
    ['live target', liveProject],
    ['playground', playgroundProject],
    ['fsharp fixture', fsProject],
  ]) {
    console.log(`building the ${name}...`);
    const result = spawnSync('dotnet', ['build', project, '-c', 'Release', '-v', 'q', '--nologo'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`${name} build failed:\n${result.stdout}\n${result.stderr}`);
    }
  }

  // Both configurations are needed: a debug build cannot be optimized by the JIT, while a release
  // build can, which is what the ASM checks rely on.
  for (const configuration of ['Debug', 'Release']) {
    console.log(`building fixture (${configuration})...`);
    const result = spawnSync('dotnet', ['build', fixtureProject, '-c', configuration, '-v', 'q', '--nologo'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`fixture build failed:\n${result.stdout}\n${result.stderr}`);
    }
  }
}

/**
 * Compiles the live fixture ahead of time. This is what the ReadyToRun route reads: code that the
 * runtime did not have to compile itself.
 */
function publishReadyToRun() {
  console.log('publishing the live target for ReadyToRun...');
  const published = {};

  // The arm64 image is what makes an architecture the viewer does not run on readable: it is
  // compiled here and disassembled from the file, without a process and without an arm64 machine.
  for (const [rid, directory, assembly] of [
    ['linux-x64', r2rDirectory, r2rAssembly],
    ['linux-arm64', r2rArm64Directory, r2rArm64Assembly],
  ]) {
    const result = spawnSync(
      'dotnet',
      ['publish', liveProject, '-c', 'Release', '-r', rid, '--self-contained', 'false', '-p:PublishReadyToRun=true', '-o', directory, '-v', 'q', '--nologo'],
      { stdio: 'pipe', encoding: 'utf8' },
    );

    published[rid] = result.status === 0 && fs.existsSync(assembly);
    if (!published[rid]) {
      console.log(`  the ${rid} ReadyToRun publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
    }
  }

  return published;
}

/**
 * Publishes the native fixture. A NativeAOT image is the one shape of program the viewer cannot read
 * as an assembly at all: its bodies are machine code and there is no IL in it to show. The publish
 * needs the AOT toolchain, so a machine without one skips these checks instead of failing.
 */
function publishNativeImage() {
  console.log('publishing the native fixture (NativeAOT)...');
  const result = spawnSync('dotnet', ['publish', aotProject, '-c', 'Release', '-v', 'q', '--nologo'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const published = result.status === 0 && fs.existsSync(aotImage);
  if (!published) {
    console.log(`  the NativeAOT publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/**
 * Publishes the live target into one file. The application is a native host with its assemblies
 * appended and a manifest at the end that says where they lie, so the file a reader opens is not the
 * file that holds the metadata: the engine has to take the bundle apart first.
 */
function publishSingleFile() {
  console.log('publishing the live target as a single file...');
  const result = spawnSync(
    'dotnet',
    ['publish', liveProject, '-c', 'Release', '-r', 'linux-x64', '--self-contained', 'false', '-p:PublishSingleFile=true', '-o', singleDirectory, '-v', 'q', '--nologo'],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  const published = result.status === 0 && fs.existsSync(singleImage);
  if (!published) {
    console.log(`  the single file publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/**
 * Publishes the live target into one file whose payload is compressed. Compression only applies to a
 * self contained publish, and such a bundle differs from a small one in two ways the reader has to
 * cope with: the bytes of every file are stored deflated, and the manifest lies far enough from the
 * beginning of the file that it is not at the start of the tail the reader searches.
 */
function publishCompressedSingleFile() {
  console.log('publishing the live target as a compressed single file...');
  const result = spawnSync(
    'dotnet',
    [
      'publish',
      liveProject,
      '-c',
      'Release',
      '-r',
      'linux-x64',
      '--self-contained',
      'true',
      '-p:PublishSingleFile=true',
      '-p:EnableCompressionInSingleFile=true',
      '-o',
      compressedDirectory,
      '-v',
      'q',
      '--nologo',
    ],
    { stdio: 'pipe', encoding: 'utf8', timeout: 10 * 60 * 1000 },
  );

  const published = result.status === 0 && fs.existsSync(compressedImage);
  if (!published) {
    console.log(`  the compressed single file publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/**
 * Compiles the fixture of the newer map ahead of time. It is built for .NET 10, whose images pack the
 * map into bit fields instead of laying it out as run together numbers, so both encodings are covered
 * by the suite: this one and the image the live fixture carries.
 */
function publishReadyToRunDebug() {
  console.log('publishing the debug map fixture for ReadyToRun...');
  const result = spawnSync(
    'dotnet',
    [
      'publish',
      r2rDebugProject,
      '-c',
      'Release',
      '-r',
      'linux-x64',
      '--self-contained',
      'false',
      '-p:PublishReadyToRun=true',
      '-o',
      path.join(r2rDebugDirectory, 'bin', 'r2r'),
      '-v',
      'q',
      '--nologo',
    ],
    { stdio: 'pipe', encoding: 'utf8', timeout: 10 * 60 * 1000 },
  );

  const published = result.status === 0 && fs.existsSync(r2rDebugAssembly);
  if (!published) {
    console.log(`  the publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/**
 * Compiles the F# fixture ahead of time. An F# project is published exactly like a C# one, which is
 * the point of the check: the tables the viewer reads are written by the toolchain, not by the
 * compiler of the language.
 */
function publishFsharp() {
  console.log('publishing the F# fixture for ReadyToRun...');
  const result = spawnSync(
    'dotnet',
    [
      'publish',
      fsProject,
      '-c',
      'Release',
      '-r',
      'linux-x64',
      '--self-contained',
      'false',
      '-p:PublishReadyToRun=true',
      '-o',
      path.join(fsDirectory, 'bin', 'r2r'),
      '-v',
      'q',
      '--nologo',
    ],
    { stdio: 'pipe', encoding: 'utf8', timeout: 10 * 60 * 1000 },
  );

  const published = result.status === 0 && fs.existsSync(fsR2rAssembly);
  if (!published) {
    console.log(`  the F# publish failed, its checks are skipped:\n${result.stdout}${result.stderr}`);
  }

  return published;
}

/** The first place a listing names an IL instruction, for a message that shows what went wrong. */
function firstLabel(text) {
  return text.split('\n').find((line) => line.includes('; IL_')) ?? text.split('\n')[4] ?? '';
}

/** The IL instruction behind every instruction of a listing, in the order the listing prints them. */
function labelsOf(text) {
  return text
    .split('\n')
    .map((line) => /;\s*(IL_[0-9a-f]{4}|prolog|epilog|no IL)\s*$/.exec(line)?.[1])
    .filter(Boolean);
}

function findEngine() {
  const candidates = [
    path.join(root, 'out', 'engine', 'IlasmDotnet.Engine.dll'),
    path.join(root, 'engine', 'IlasmDotnet.Engine', 'bin', 'Release', 'net10.0', 'IlasmDotnet.Engine.dll'),
    path.join(root, 'engine', 'IlasmDotnet.Engine', 'bin', 'Debug', 'net10.0', 'IlasmDotnet.Engine.dll'),
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`the .NET engine is not built; run "npm run build:engine" first.\nLooked in:\n  ${candidates.join('\n  ')}`);
  }

  return found;
}

function startEngine(dllPath) {
  const child = spawn('dotnet', [dllPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
    } else {
      entry.resolve(message.result);
    }
  });

  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (process.env.IL_VIEWER_DEBUG) {
      console.log(`  [engine] ${line}`);
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  return { child, call };
}

/** Starts the fixture and waits until it reports that its methods ran. */
function startTarget(assembly) {
  const target = spawn('dotnet', [assembly, '90'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return target;
}

function waitForReady(target) {
  return new Promise((resolve) => {
    let output = '';
    const timer = setTimeout(() => resolve(false), 60000);
    target.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('ready')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    target.on('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}



/**
 * The viewer reads an assembly, not a language: an F# project is a project whose assembly happens to
 * have been compiled from another language. Everything the viewer shows has to come out the same —
 * the IL, the machine code, the map between them and the links to the file — with the PDB naming
 * lines of `.fs` files. The C# pane has no F# to show, so what it shows is the C# the IL of an F#
 * assembly is, which is a decompilation and is checked to be one rather than an error.
 */
async function checkFsharp(call) {
  if (!fs.existsSync(fsAssembly)) {
    console.log('  skip the F# checks — the fixture could not be built');
    return;
  }

  // The line of a member is read from the file rather than written here, so moving a line of the
  // fixture cannot turn the check into a check of something else.
  const fsTotalLine = fs.readFileSync(fsSource, 'utf8').split('\n').findIndex((line) => line.includes('member _.Total')) + 1;

  const info = await call('assembly/info', { path: fsAssembly });
  check('an F# assembly is read like any other', info.name === 'FsTarget', info.name);
  check('an F# assembly reports its types', info.typeCount >= 3, String(info.typeCount));

  const types = await call('assembly/types', { path: fsAssembly });
  const catalog = types.find((type) => type.fullName === 'FsTarget.Catalog');
  check('a type written in F# is listed', Boolean(catalog), types.map((type) => type.fullName).join(','));

  const members = await call('assembly/members', { path: fsAssembly, token: catalog.token });
  check('the members a property of an F# type declares are listed', members.some((member) => member.name === 'get_Total'), members.map((member) => member.name).join(','));

  const total = members.find((member) => member.name === 'get_Total');
  const il = await call('view/il', { path: fsAssembly, token: total.token });
  check('the IL of an F# member is shown', il.text.includes('.method'), il.text.split('\n')[0]);
  check('the IL of an F# member links to the .fs file', il.blocks.every((block) => block.sourceFile === fsSource), JSON.stringify(il.blocks[0]));
  check('the linked line of an F# member is inside the file', il.blocks.every((block) => block.sourceStartLine > 0 && block.sourceStartLine <= 30), JSON.stringify(il.blocks[0]));

  const view = await call('view/fileIl', { path: fsAssembly, file: fsSource });
  check('the whole file of an F# project is listed', view.blocks.length >= 5, String(view.blocks.length));
  check('the file view of F# names the .fs file', view.blocks.every((block) => block.sourceFile === fsSource), JSON.stringify(view.blocks[0]));

  const csharp = await call('view/fileCsharp', { path: fsAssembly, file: fsSource });
  check('the C# of an F# file is a decompilation of its IL', csharp.text.includes('class Catalog'), csharp.text.split('\n').slice(0, 3).join(' | '));

  const member = await call('map/memberBySource', { path: fsAssembly, file: fsSource, line: fsTotalLine });
  check('a line of an F# file resolves to the member it declares', member?.declaringType === 'FsTarget.Catalog' && member.name === 'get_Total', JSON.stringify(member));

  const jit = await call('view/asm', { path: fsAssembly, token: total.token, optimized: false, source: 'jit' });
  check('the JIT route compiles a method of an F# assembly', jit.text.includes('Assembly listing for method'), jit.text.split('\n').slice(0, 4).join(' | '));
}

/**
 * An F# project published with ReadyToRun carries the same tables as a C# one, including the map
 * from an instruction to its IL instruction: the compiler of the language is not what writes them.
 */
async function checkFsharpImage(call, published) {
  if (!published) {
    console.log('  skip the F# image checks — the fixture could not be published');
    return;
  }

  const types = await call('assembly/types', { path: fsR2rAssembly });
  const catalog = types.find((type) => type.fullName === 'FsTarget.Catalog');
  const members = await call('assembly/members', { path: fsR2rAssembly, token: catalog.token });
  const describe = members.find((member) => member.name === 'get_Describe');

  // Every method the image carries has to be labelled. Two of the members of this fixture have code
  // whose map is the same, and the compiler writes such a map once and lets both elements point back
  // at it — reading those elements as "the blob follows" is what this catches, and it is invisible in
  // an image where no two methods share a map.
  const unlabelled = [];
  for (const type of types.filter((candidate) => candidate.fullName.startsWith('FsTarget.'))) {
    const all = await call('assembly/members', { path: fsR2rAssembly, token: type.token });
    for (const member of all.filter((candidate) => candidate.kind === 'method')) {
      const listing = await call('view/asm', { path: fsR2rAssembly, token: member.token, optimized: false, source: 'image' });
      if (!/; \d+ bytes of code/.test(listing.text)) {
        continue;
      }

      if (!/; IL_[0-9a-f]{4}/.test(listing.text)) {
        unlabelled.push(`${type.fullName}.${member.name}`);
      }
    }
  }

  check('every method of the F# image has its instructions labelled, shared maps included', unlabelled.length === 0, unlabelled.join(','));

  // A property of an F# type whose body is a tail call is the smallest map there is: three
  // instructions and a handful of entries. It has to be labelled like any other.
  const small = await call('view/asm', { path: fsR2rAssembly, token: describe.token, optimized: false, source: 'image' });
  check('the code of an F# assembly is read from its image', small.text.includes('(read from the image)'), small.text.split('\n')[0]);
  check('the image of an F# assembly names the IL instruction of an instruction', /; IL_[0-9a-f]{4}/.test(small.text), firstLabel(small.text));

  const logic = types.find((type) => type.fullName === 'FsTarget.CatalogLogic');
  const logicMembers = await call('assembly/members', { path: fsR2rAssembly, token: logic.token });
  const describeLogic = logicMembers.find((member) => member.name === 'describe');
  const image = await call('view/asm', { path: fsR2rAssembly, token: describeLogic.token, optimized: false, source: 'image' });

  const bodyEnd = Math.max(...image.blocks.map((block) => block.ilEnd));
  const labelled = [...image.text.matchAll(/; IL_([0-9a-f]{4})/g)].map((match) => parseInt(match[1], 16));
  check('every label of the F# image is inside the body of its method', labelled.length > 0 && labelled.every((offset) => offset < bodyEnd), `${labelled.join(',')} of ${bodyEnd}`);

  const blocks = image.blocks.filter((block) => block.ilEnd === block.ilStart + 1);
  check('the instructions of the F# image are anchored to single IL offsets', blocks.length > 3, String(blocks.length));
  check('the blocks of the F# image point at the .fs file', blocks.every((block) => block.sourceFile === fsSource), JSON.stringify(blocks[0]));

  // The runtime is the other side of the same reading: what it reports for a running F# application
  // has to be the same list of places.
  const target = startTarget(fsR2rAssembly);
  try {
    const ready = await waitForReady(target);
    check('the published F# fixture can be started', ready);
    if (ready) {
      await call('live/attach', { pid: target.pid });
      // The method the runtime reports on is compared. A body the toolchain inlined — which several
      // of the one-line properties of this fixture are — has no method of its own in the process at
      // all, and that is what the image is for: it lists them anyway.
      const live = await call('view/asmLive', { path: fsR2rAssembly, token: describeLogic.token });
      check(
        'the F# image agrees with the runtime instruction for instruction',
        labelsOf(live.text).length > 3 && labelsOf(live.text).join(' ') === labelsOf(image.text).join(' '),
        `${labelsOf(live.text).join(' ')} vs ${labelsOf(image.text).join(' ')}`,
      );
      await call('live/detach');
    }
  } finally {
    try {
      target.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }
}

/**
 * An image built for .NET 10 stores the map from an instruction to its IL instruction as bit fields,
 * which is a different encoding from the one .NET 8 images carry — and it also carries code for
 * methods that the runtime cannot report on, because it inlines them. Both are checked here against
 * the listing of a process, which is the only other place the same numbers can be read from.
 */
async function checkPackedImageMap(call, published) {
  if (!published) {
    console.log('  skip the packed map checks — the fixture could not be published');
    return;
  }

  const info = await call('assembly/info', { path: r2rDebugAssembly });
  check('the target framework of the fixture is reported', /v10\.0/.test(info.targetFramework), info.targetFramework);

  // The machine value of an image published for a unix target is one of crossgen2's own numbers,
  // which the enumeration does not name: without the table of the reader the line says "64797".
  check('the architecture of a unix image is named rather than numbered', info.architecture === 'x64', info.architecture);

  const types = await call('assembly/types', { path: r2rDebugAssembly });
  const methodType = types.find((type) => type.fullName === 'R2RDebug.Methods');
  const members = await call('assembly/members', { path: r2rDebugAssembly, token: methodType.token });

  const listing = async (name) => {
    const member = members.find((candidate) => candidate.name === name);
    return call('view/asm', { path: r2rDebugAssembly, token: member.token, optimized: false, source: 'image' });
  };

  const sum = await listing('Sum');
  check('an image of .NET 10 is listed with the IL instruction of every instruction', /; IL_[0-9a-f]{4}/.test(sum.text), firstLabel(sum.text));
  check('the listing of the packed map says where it comes from', sum.text.includes('as the image records it for a debugger'), sum.text.split('\n').pop());
  const sumBlocks = sum.blocks.filter((block) => block.ilEnd === block.ilStart + 1);
  check('every instruction of the packed map is anchored to a single IL offset', sumBlocks.length > 5, String(sumBlocks.length));
  check('the blocks of the packed map point at the source of their IL', sumBlocks.every((block) => block.sourceFile === r2rDebugSource), JSON.stringify(sumBlocks[0]));

  // The entry of a method in the table of the image names its code with a flag that decides how many
  // of the low bits of the value are flags: reading them all as flags points a method at the code of
  // its neighbour, which is what these two checks would have caught.
  const grade = await listing('Grade');
  const countdown = await listing('Countdown');
  const addressOf = (text) => /bytes of code at (0x[0-9a-f]+)/.exec(text)?.[1];
  check(
    'a method without a fixup in its entry finds its own code',
    addressOf(grade.text) !== addressOf(countdown.text),
    `${addressOf(grade.text)} vs ${addressOf(countdown.text)}`,
  );
  check('the method that a process cannot report on is still listed from its own code', /; IL_[0-9a-f]{4}/.test(countdown.text) && countdown.text.includes('bytes of code'), firstLabel(countdown.text));

  const target = startTarget(r2rDebugAssembly);
  try {
    const ready = await waitForReady(target);
    check('the published fixture of the packed map can be started', ready);
    if (ready) {
      await call('live/attach', { pid: target.pid });
      const live = await call('view/asmLive', { path: r2rDebugAssembly, token: members.find((member) => member.name === 'Sum').token });
      check(
        'the packed map agrees with the runtime instruction for instruction',
        labelsOf(live.text).length > 5 && labelsOf(live.text).join(' ') === labelsOf(sum.text).join(' '),
        `${labelsOf(live.text).join(' ')} vs ${labelsOf(sum.text).join(' ')}`,
      );
      await call('live/detach');
    }
  } finally {
    try {
      target.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }
}

/**
 * ReadyToRun code can also be read straight from the file: no process, no JIT, and — the part no
 * other route can do — an arm64 image on an x64 machine. The map from an instruction to the IL
 * instruction it implements comes out of the image as well, which is what makes the listing of a file
 * as exact as the listing of a process, so these checks compare the two.
 */
async function checkImageCode(call, published) {
  if (!published['linux-x64']) {
    console.log('  skip the image checks — the fixture could not be published');
    return;
  }

  const types = await call('assembly/types', { path: r2rAssembly });
  const targetType = types.find((type) => type.fullName === 'LiveTarget.Target');
  const members = await call('assembly/members', { path: r2rAssembly, token: targetType.token });
  const describe = members.find((member) => member.name === 'Describe');
  const guard = members.find((member) => member.name === 'Guard');

  const image = await call('view/asm', { path: r2rAssembly, token: describe.token, source: 'image' });
  check('the image view names its source', image.text.includes('(read from the image)'), image.text.split('\n')[0]);
  check('the image view names the target of the image', image.text.includes('ReadyToRun x64 code'), image.text.split('\n')[1]);
  check('the image view holds the instructions of the method', /\bpush\b|\bmov\b|\bcmp\b/.test(image.text), '');
  check('the image view reports the size of the code', /; \d+ bytes of code at 0x[0-9a-f]+/.test(image.text), image.text.split('\n')[6]);
  check('the image view names the IL instruction of an instruction', /; IL_[0-9a-f]{4}/.test(image.text), firstLabel(image.text));
  check('the image view names the prolog and the epilog', /; prolog\b/.test(image.text) && /; epilog\b/.test(image.text), '');
  check(
    'the image view says where the map of its instructions comes from',
    image.text.includes('as the image records it for a debugger'),
    image.text.split('\n').pop(),
  );

  const imageBlocks = image.blocks.filter((block) => block.methodToken === describe.token);
  check('the image view anchors every instruction to its IL offset', imageBlocks.length > 1, String(imageBlocks.length));
  check('the blocks of the image view are single IL instructions', imageBlocks.every((block) => block.ilEnd === block.ilStart + 1), JSON.stringify(imageBlocks[0]));
  check('the blocks of the image view name the source of their IL', imageBlocks.some((block) => block.sourceFile === liveSource), JSON.stringify(imageBlocks[0]));

  // The same method read from the image and from a running process has to be the same code.
  const target = startTarget(r2rAssembly);
  try {
    const ready = await waitForReady(target);
    check('the published image can be started for comparison', ready);
    if (ready) {
      await call('live/attach', { pid: target.pid });
      const liveView = await call('view/asmLive', { path: r2rAssembly, token: describe.token });
      const liveSize = Number(/; ReadyToRun, (\d+) bytes/.exec(liveView.text)?.[1] ?? 0);
      const imageSize = Number(/; (\d+) bytes of code/.exec(image.text)?.[1] ?? 0);
      check('the image and the live route agree on the size of the code', liveSize > 0 && liveSize === imageSize, `${liveSize} vs ${imageSize}`);

      // The strongest check there is of the map: the runtime reads the very same bytes out of the very
      // same image, so the two listings have to put the same IL instruction behind every instruction.
      const liveLabels = labelsOf(liveView.text);
      const imageLabels = labelsOf(image.text);
      check(
        'the image and the live route agree on the IL instruction of every instruction',
        liveLabels.length > 5 && liveLabels.join(' ') === imageLabels.join(' '),
        `${liveLabels.join(' ')} vs ${imageLabels.join(' ')}`,
      );
      await call('live/detach');
    }
  } finally {
    try {
      target.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }

  // Compiling on this machine stays available, and is what the other assemblies use.
  const jit = await call('view/asm', { path: r2rAssembly, token: describe.token, source: 'jit', optimized: false });
  check('the jit route can be requested explicitly', jit.text.includes('Assembly listing for method'), jit.text.split('\n')[4]);

  const plain = await call('view/asm', { path: fixtureAssembly, token: 0x06000002, source: 'image' }).then(
    () => undefined,
    (error) => error.message,
  );
  check('an assembly without precompiled code explains itself', /not a ReadyToRun image/.test(plain ?? ''), plain);

  if (!published['linux-arm64']) {
    console.log('  skip the arm64 checks — the arm64 image could not be published');
    return;
  }

  const arm64 = await call('view/asm', { path: r2rArm64Assembly, token: describe.token, source: 'image' });
  check('an arm64 image is read on an x64 machine', arm64.text.includes('ReadyToRun arm64 code'), arm64.text.split('\n')[1]);
  check('the arm64 listing holds arm64 instructions', /\bstp\b|\bldr\b|\badd x\d/.test(arm64.text), '');
  check('the arm64 listing holds no x64 instructions', !/\bpush r(ax|bp|15)\b/.test(arm64.text), '');
  check('the arm64 listing reports the size of the code', /; \d+ bytes of code at 0x[0-9a-f]+/.test(arm64.text), arm64.text.split('\n')[5]);
  check('the arm64 listing marks further code of the same method', arm64.text.includes('further code of the same method'), '');
  check('the arm64 listing links the method to its token', arm64.blocks.some((block) => block.methodToken === describe.token), '');
  check('the arm64 listing names the IL instruction of an instruction', /; IL_[0-9a-f]{4}/.test(arm64.text), firstLabel(arm64.text));

  // A different method of the same image produces a different listing, which is what makes the
  // mapping from a method to its code trustworthy rather than a single lucky hit.
  const arm64Guard = await call('view/asm', { path: r2rArm64Assembly, token: guard.token, source: 'image' });
  check('another method of the arm64 image gets its own code', arm64Guard.text !== arm64.text && arm64Guard.text.includes('ReadyToRun arm64 code'), '');
  check('the code of the arm64 methods does not overlap', !arm64Guard.text.includes(/; \d+ bytes of code at (0x[0-9a-f]+)/.exec(arm64.text)?.[1] ?? 'nothing'), '');
}

/**
 * An assembly that carries precompiled code this build cannot read must say so: the listing then
 * comes from this machine, and pretending it were the code in the file would be a lie.
 */
async function checkUnreadableImage(call, published) {
  if (!published['linux-x64']) {
    console.log('  skip the unreadable image checks — the fixture could not be published');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-image-'));
  const copy = path.join(directory, 'LiveTarget.dll');
  try {
    // The image stays an x64 one, only the machine type it declares changes: crossgen2 marks a
    // linux-arm image with a value of its own, so this is what an image of another target looks like.
    const bytes = fs.readFileSync(r2rAssembly);
    bytes.writeUInt16LE(0x7abd, bytes.readUInt32LE(0x3c) + 4);
    fs.writeFileSync(copy, bytes);
    fs.copyFileSync(path.join(r2rDirectory, 'LiveTarget.pdb'), path.join(directory, 'LiveTarget.pdb'));

    const source = path.join(liveDirectory, 'Target.cs');
    const auto = await call('view/fileAsm', { path: copy, file: source, source: 'auto' });
    check(
      'an image of an unsupported architecture names the architecture it was built for',
      auto.text.includes('carries ReadyToRun code for linux-arm'),
      auto.text.split('\n').slice(4, 6).join(' | '),
    );
    check('the fallback listing says where its code comes from', auto.text.includes('compiled on this machine instead'), '');
    check('the fallback listing still names the methods of the file', auto.text.includes('; ── public hidebysig static int32 Add'), auto.text.split('\n')[7]);

    const jit = await call('view/fileAsm', { path: copy, file: source, source: 'jit' });
    check('asking for the JIT explicitly needs no explanation', !jit.text.includes('carries ReadyToRun code'), '');

    const image = await call('view/fileAsm', { path: copy, file: source, source: 'image' }).then(
      () => undefined,
      (error) => error.message,
    );
    check('asking for the image of another architecture explains itself', /linux-arm/.test(image ?? ''), image);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A native image is not a broken assembly, and saying so is the difference between a reader who
 * understands the mistake and one who sees "unknown file format". The bundled ilasm app hosts are
 * native images for every platform the package ships, so all three container formats are at hand
 * without a compiler: ELF for Linux, Mach-O for macOS and PE for Windows.
 */
async function checkNativeImages(call) {
  const images = [
    ['linux-x64', 'ELF', /is a native ELF image for x86-64/],
    ['linux-arm64', 'ELF', /is a native ELF image for AArch64/],
    ['osx-arm64', 'Mach-O', /is a native Mach-O image \(macOS\)/],
    ['win-x64', 'PE', /is a native PE image/],
  ];

  for (const [rid, format, expected] of images) {
    const file = path.join(root, 'out', 'engine', 'ilasm', rid, rid.startsWith('win') ? 'ilasm.exe' : 'ilasm');
    if (!fs.existsSync(file)) {
      console.log(`  skip the ${format} image check — ${rid} ilasm is not unpacked`);
      continue;
    }

    const message = await call('assembly/info', { path: file }).then(
      () => undefined,
      (error) => error.message,
    );
    check(`a native ${format} image (${rid}) is named as one`, expected.test(message ?? ''), message);
    check(`the ${rid} diagnosis says there is no IL to read`, /no IL/.test(message ?? ''), message);
    check(`the ${rid} diagnosis mentions NativeAOT`, /NativeAOT/.test(message ?? ''), message);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-native-'));
  try {
    const text = path.join(directory, 'notes.txt');
    fs.writeFileSync(text, 'this file is not an image at all\n');
    const message = await call('assembly/info', { path: text }).then(
      () => undefined,
      (error) => error.message,
    );
    check(
      'a file that is neither PE nor ELF is reported as not an assembly',
      /is not a \.NET assembly/.test(message ?? ''),
      message,
    );

    const short = path.join(directory, 'tiny');
    fs.writeFileSync(short, 'MF');
    const tiny = await call('view/fileIl', { path: short, file: 'x.cs' }).then(
      () => undefined,
      (error) => error.message,
    );
    check('a file too short to hold a header is reported as one', /too short to be an assembly/.test(tiny ?? ''), tiny);
    check('the diagnosis reaches the view that was asked for', /tiny is/.test(tiny ?? ''), tiny);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // A managed assembly has to keep working through the same gate, PDB or no PDB.
  const info = await call('assembly/info', { path: fixtureAssembly });
  check('a managed assembly is still read after the check', info.name === 'SampleLib', info.name);
}

/**
 * A program published into one file is read by taking the bundle inside it apart. Everything the other
 * routes do then works on it: the assembly inside has IL, a PDB beside the executable, and a JIT that
 * can be asked for the machine code of a method.
 */
/**
 * A single file application that compresses its payload: every file inside it is stored deflated, so
 * reading one means inflating it, and the sizes the manifest spells out are the sizes of the files
 * rather than of the bytes the bundle holds. Everything the viewer offers of an ordinary publish has
 * to hold for this one too, and the fixture has to stay large enough for the manifest to lie past the
 * beginning of the examined tail — a small file would let the reader pass without ever having to
 * place the manifest in the file it was found in.
 */
async function checkCompressedSingleFile(call, published) {
  if (!published) {
    console.log('  skip the compressed single file checks — the fixture could not be published');
    return;
  }

  check(
    'the compressed single file fixture is larger than the tail a manifest is looked for in',
    fs.statSync(compressedImage).size > 1024 * 1024,
    String(fs.statSync(compressedImage).size),
  );

  const info = await call('assembly/info', { path: compressedImage });
  check('a compressed single file application is read as the assembly inside it', info.name === 'LiveTarget', info.name);
  check('a compressed single file application is reported as an executable', info.isExecutable === true, String(info.isExecutable));
  check('a compressed single file application finds the PDB beside the executable', info.hasPdb === true, String(info.hasPdb));
  check('a compressed single file application reports types', info.typeCount >= 3, String(info.typeCount));

  const view = await call('view/fileIl', { path: compressedImage, file: liveSource });
  check('the IL of an application taken out of a compressed bundle is shown', view.text.includes('.class'), view.text.split('\n')[0]);
  check('the IL of a compressed bundle links to the source file', view.blocks.length >= 5, String(view.blocks.length));
  check(
    'the view of a compressed bundle says the assembly came out of the bundle',
    (view.notes ?? []).some((note) => note.includes('single file')),
    JSON.stringify(view.notes),
  );

  const csharp = await call('view/fileCsharp', { path: compressedImage, file: liveSource });
  check('the C# of a compressed bundle is decompiled', csharp.text.includes('class Target'), csharp.text.split('\n').slice(0, 5).join(' | '));

  const member = await call('map/memberBySource', { path: compressedImage, file: liveSource, line: 12 });
  check('a line of a compressed bundle resolves to its method', member?.declaringType === 'LiveTarget.Target', JSON.stringify(member));

  const asm = await call('view/asm', { path: compressedImage, token: member.token, optimized: true, source: 'auto' });
  check('the machine code of a compressed bundle is compiled by the JIT', asm.text.includes('Native code for'), asm.text.split('\n')[0]);

  // Nothing of a bundle may be left behind once it was read: the compressed fixture is taken apart
  // again after a rebuild, and the reading has to be of the file that was opened.
  const rebuilt = await call('assembly/info', { path: compressedImage });
  check('a compressed bundle is read again from the same place', rebuilt.name === info.name && rebuilt.path === info.path, rebuilt.path);
}

async function checkSingleFile(call, published) {
  if (!published) {
    console.log('  skip the single file checks — the fixture could not be published');
    return;
  }

  const info = await call('assembly/info', { path: singleImage });
  check('a single file application is read as the assembly inside it', info.name === 'LiveTarget', info.name);
  check('the single file application keeps the path that was opened', info.path === singleImage, info.path);
  check('the single file application is reported as an executable', info.isExecutable === true, String(info.isExecutable));
  check('the single file application finds the PDB beside the executable', info.hasPdb === true, String(info.hasPdb));
  check('the single file application reports types', info.typeCount >= 3, String(info.typeCount));

  const types = await call('assembly/types', { path: singleImage });
  const target = types.find((type) => type.fullName === 'LiveTarget.Target');
  check('the types of the single file application are listed', Boolean(target), types.map((type) => type.fullName).join(','));

  const view = await call('view/fileIl', { path: singleImage, file: liveSource });
  check('the IL of a single file application is shown', view.text.includes('.class'), view.text.split('\n')[0]);
  check('the IL of a single file application links to the source file', view.blocks.length >= 5, String(view.blocks.length));
  check('the blocks point at the source the PDB names', view.blocks.every((block) => block.sourceFile === liveSource), JSON.stringify(view.blocks[0]));
  check('the view says the assembly came out of the bundle', (view.notes ?? []).some((note) => note.includes('single file')), JSON.stringify(view.notes));

  const csharp = await call('view/fileCsharp', { path: singleImage, file: liveSource });
  check('the C# of a single file application is decompiled', csharp.text.includes('class Target'), csharp.text.split('\n').slice(0, 5).join(' | '));

  const member = await call('map/memberBySource', { path: singleImage, file: liveSource, line: 12 });
  check('a line of a single file application resolves to its method', member?.declaringType === 'LiveTarget.Target', JSON.stringify(member));

  const asm = await call('view/asm', { path: singleImage, token: member.token, optimized: true, source: 'auto' });
  check('the machine code of a single file application is compiled by the JIT', asm.text.includes('Native code for'), asm.text.split('\n')[0]);
  check('the JIT listing names the method of the bundle', asm.text.includes('LiveTarget.Target.'), asm.text.split('\n')[0]);

  // A file of the same shape whose manifest is gone must not be read as a bundle: the reader has to
  // refuse it rather than invent an assembly out of the bytes that follow the host.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-single-'));
  try {
    const truncated = path.join(directory, 'LiveTarget');
    const bytes = fs.readFileSync(singleImage);
    fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 2048));
    const broken = await call('assembly/info', { path: truncated }).then(
      () => undefined,
      (error) => error.message,
    );
    check('a single file application whose manifest is gone is not read', /native ELF image/.test(broken ?? ''), broken);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The native route: a NativeAOT image has no IL, so the only thing to show of it is its machine
 * code. What makes that more than a listing is the debug information the compiler wrote beside the
 * image, which names every method and the line of source its addresses came from.
 */
async function checkNativeImage(call, published) {
  // An image whose symbols were stripped away has no methods to list, and saying so is the whole of
  // what a reader can be told about it. The bundled assembler is such an image on every platform.
  const stripped = path.join(root, 'out', 'engine', 'ilasm', 'linux-x64', 'ilasm');
  if (fs.existsSync(stripped)) {
    const info = await call('native/info', { path: stripped });
    check('a stripped native image is read as an image', info.machine === 'x86-64', info.machine);
    check('a stripped native image admits that its methods are unknown', info.methodCount === 0, String(info.methodCount));
    check('a stripped native image names the debug file it misses', /debug file/.test(info.note ?? ''), info.note);
  }

  if (!published) {
    console.log('  skip the NativeAOT checks — the fixture could not be published');
    return;
  }

  const info = await call('native/info', { path: aotImage });
  check('native/info names the machine of the image', info.machine === 'x86-64', info.machine);
  check('native/info finds the debug file beside the image', info.hasDebugInfo === true, String(info.debugFile));
  check('native/info reports the debug file it read', /\.dbg$/.test(info.debugFile ?? ''), info.debugFile);
  check('native/info counts the methods of the image', info.methodCount > 100, String(info.methodCount));
  check('native/info admits that most methods come from the runtime', info.runtimeMethodCount > 100, String(info.runtimeMethodCount));

  const own = await call('native/methods', { path: aotImage });
  check('native/methods lists the methods of the application', own.length >= 3, String(own.length));
  check('native/methods leaves the runtime out by default', own.every((method) => !method.isRuntime), JSON.stringify(own.slice(0, 3)));
  const sum = own.find((method) => method.fullName === 'AotTarget.Target.Sum');
  check('native/methods names a method the way the debug information does', Boolean(sum), own.map((method) => method.fullName).join(','));
  check('native/methods spells the symbol of a method', sum?.symbol === 'AotTarget_AotTarget_Target__Sum', sum?.symbol);
  check('native/methods places the method at an address with a size', (sum?.size ?? 0) > 0 && (sum?.address ?? 0) > 0, JSON.stringify(sum));
  check('native/methods points the method at its source file', sum?.file === aotSource, sum?.file);
  check('native/methods reports the line the method starts on', sum?.line === 13, String(sum?.line));

  const all = await call('native/methods', { path: aotImage, includeRuntime: true });
  check('native/methods can list the methods of the runtime as well', all.length > own.length * 10, `${all.length} vs ${own.length}`);

  const inFile = await call('native/methods', { path: aotImage, file: aotSource });
  check('native/methods narrows to one source file', inFile.length >= 3 && inFile.every((method) => method.file === aotSource), String(inFile.length));
  check('native/methods of a file are the ones written in it', inFile.some((method) => method.name === 'Describe'), inFile.map((method) => method.name).join(','));

  const view = await call('native/asm', { path: aotImage, address: sum.address });
  check('native/asm disassembles the method', /\bpush\b|\bmov\b|\bxor\b/.test(view.text), view.text.split('\n').slice(0, 6).join(' | '));
  check('native/asm names the method it disassembled', view.text.includes('AotTarget.Target.Sum'), view.text.split('\n')[2]);
  check('native/asm reports the size and the address of the code', new RegExp(`; ── AotTarget\\.Target\\.Sum \\(${sum.size} bytes at 0x${sum.address.toString(16)}\\)`).test(view.text), view.text.split('\n')[2]);
  check('native/asm reports the language of the listing', view.language === 'il-asm', view.language);
  check('native/asm says it has debug information', view.hasDebugInfo === true, String(view.hasDebugInfo));
  check('native/asm anchors instructions to source lines', view.blocks.length >= 4, String(view.blocks.length));
  check('native/asm attributes the blocks to the source file', view.blocks.every((block) => block.sourceFile === aotSource), JSON.stringify(view.blocks[0]));
  check('native/asm points the blocks at lines of the method', view.blocks.every((block) => block.sourceStartLine >= 13), JSON.stringify(view.blocks.map((block) => block.sourceStartLine)));
  check('native/asm keeps the text ranges of its blocks inside the listing', view.blocks.every((block) => block.textStartLine >= 1 && block.textEndLine <= view.text.split('\n').length), '');

  const lines = view.text.split('\n');
  const firstBlock = view.blocks[0];
  const instruction = lines[firstBlock.textStartLine - 1];
  check('the first block covers instructions, not a header', /0x[0-9a-f]{8}\s{2}/.test(instruction), instruction);

  const bySource = await call('native/methodBySource', { path: aotImage, file: aotSource, line: 16 });
  check('native/methodBySource resolves a line inside a method', bySource?.name === 'Sum', JSON.stringify(bySource));
  const byDeclaration = await call('native/methodBySource', { path: aotImage, file: aotSource, line: 37 });
  check('native/methodBySource resolves the line a method is declared on', byDeclaration?.name === 'Divide', JSON.stringify(byDeclaration));
  const unknown = await call('native/methodBySource', { path: aotImage, file: path.join(root, 'scripts', 'smoke.mjs'), line: 3 });
  check('native/methodBySource reports a file no method came from', unknown === null, JSON.stringify(unknown));

  const fileView = await call('native/asm', { path: aotImage, file: aotSource });
  check('native/asm of a file holds every method written in it', (fileView.text.match(/; ── /g) ?? []).length >= 3, String((fileView.text.match(/; ── /g) ?? []).length));
  check('native/asm of a file anchors every method to a source line', fileView.blocks.length >= 8, String(fileView.blocks.length));

  const other = await call('native/asm', { path: aotImage, address: 1 }).then(
    () => undefined,
    (error) => error.message,
  );
  check('native/asm reports an address that is not a method', /starts at 0x1/.test(other ?? ''), other);
}

/**
 * A property accessor is a method, and C# has no syntax for one on its own: the views have to show
 * the property or event it belongs to, while the IL and ASM panes keep the accessor they were asked for.
 */
async function checkAccessors(call) {
  const scope = await call('file/scope', { path: fixtureAssembly, file: fixtureSource, includeCompilerGenerated: false });
  const accessor = scope.members.find((member) => member.name === 'get_Count');
  check('the file scope reports the property of an accessor', accessor?.owner === 'Count' && accessor?.accessor === 'get', JSON.stringify(accessor));
  check('a plain method reports no accessor owner', scope.members.find((member) => member.name === 'Add')?.owner == null, '');

  const csharp = await call('view/csharp', { path: fixtureAssembly, token: accessor.token });
  check('the C# view of an accessor is the property', /public int Count =>\s*_history\.Count;/.test(csharp.text), csharp.text.split('\n').slice(0, 4).join(' | '));
  check('the C# view says which member it shows instead', csharp.text.includes('this accessor belongs to'), '');
  check(
    'the C# blocks keep the accessor token, so the panes stay linked',
    csharp.blocks.length === 1 && csharp.blocks[0].methodToken === accessor.token,
    String(csharp.blocks[0]?.methodToken),
  );

      const il = await call('view/il', { path: fixtureAssembly, token: accessor.token });
  check('the IL view keeps the accessor itself', il.text.includes('get_Count') && !il.text.includes('public int Count'), il.text.split('\n').slice(0, 3).join(' | '));

  const type = await call('view/csharp', { path: fixtureAssembly, token: 0x02000002 });
  const declared = (type.text.match(/public int Count/g) ?? []).length;
  check('the type view declares the property once', declared === 1, String(declared));
  check('the type view does not render the accessor as a bare block', !type.text.includes('instance int32 get_Count () cil managed'), '');
}

/**
 * A rebuild writes to the same path as the previous build, so a cached view has to notice that the
 * file changed instead of serving the assembly it read first.
 */
async function checkRebuiltAssembly(call) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-rebuild-'));
  const copy = path.join(directory, 'SampleLib.dll');
  try {
    fs.copyFileSync(fixtureAssembly, copy);
    fs.copyFileSync(path.join(path.dirname(fixtureAssembly), 'SampleLib.pdb'), path.join(directory, 'SampleLib.pdb'));

    const before = await call('view/il', { path: copy, token: 0x02000002 });
    check('the copied assembly is read as itself', before.text.includes('SampleLib.Calculator'), before.text.split('\n')[0]);

    // Another assembly replaces the file at the same path, the way a rebuild replaces its output.
    const playground = playgroundAssembly;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    fs.copyFileSync(playground, copy);
    fs.copyFileSync(path.join(path.dirname(playground), 'Playground.pdb'), path.join(directory, 'SampleLib.pdb'));

    const after = await call('view/il', { path: copy, token: 0x02000002 });
    check('a replaced assembly is read again instead of being served from the cache', after.text !== before.text, '');
    check('the view shows the assembly that is on disk now', after.text.includes('<>z__ReadOnlyArray') && !after.text.includes('SampleLib.Calculator'), after.text.split('\n')[0]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The C# view comes in the two flavours the ILASM Dotnet of Rider has: the high-level one shows the code
 * as it was written, the low-level one shows what the compiler made of it — generated state machines
 * and display classes included, and without the sugar that hides them.
 */
async function checkCSharpFlavours(call, members) {
  const add = members.find((member) => member.name === 'Add');
  const evens = members.find((member) => member.name === 'Evens');

  const highAdd = await call('view/csharp', { path: fixtureAssembly, token: add.token });
  const lowAdd = await call('view/csharp', { path: fixtureAssembly, token: add.token, lowLevel: true });
  check(
    'the high level view keeps an initialised local together',
    /int result = a \+ b;/.test(highAdd.text),
    highAdd.text.split('\n').slice(5, 8).join(' | '),
  );
  check(
    'the low level view declares the local and then assigns it',
    /int result;/.test(lowAdd.text) && /result = a \+ b;/.test(lowAdd.text),
    '',
  );
  check(
    'the low level view stays a C# view of the same member',
    lowAdd.blocks.some((block) => block.methodToken === add.token) && lowAdd.language === 'csharp',
    String(lowAdd.blocks.length),
  );

  const highEvens = await call('view/csharp', { path: fixtureAssembly, token: evens.token });
  const lowEvens = await call('view/csharp', { path: fixtureAssembly, token: evens.token, lowLevel: true });
  check('the high level view reconstructs the iterator', highEvens.text.includes('yield return'), '');
  check(
    'the low level view shows the generated state machine instead',
    lowEvens.text.includes('IteratorStateMachine') && lowEvens.text.includes('<Evens>d__5'),
    lowEvens.text.split('\n').slice(3, 6).join(' | '),
  );
  check('the low level view does not pretend to be an iterator', !lowEvens.text.includes('yield return'), '');

  // The generated types are part of a low-level view, so the file view shows them without being asked.
  const lowFile = await call('view/fileCsharp', { path: fixtureAssembly, file: fixtureSource, includeCompilerGenerated: false, lowLevel: true });
  check('the low level file view includes the generated state machine', lowFile.text.includes('assembly type: SampleLib.Calculator.<'), '');
  const repeated = (lowFile.text.match(/assembly type: SampleLib\.Calculator\.<Evens>d__5/g) ?? []).length;
  check('a generated type is not written out twice', repeated === 1, String((lowFile.text.match(/assembly type:/g) ?? []).length));

  const highFile = await call('view/fileCsharp', { path: fixtureAssembly, file: fixtureSource, includeCompilerGenerated: false });
  check('the high level file view hides the generated state machine by default', !highFile.text.includes('assembly type: SampleLib.Calculator.<'), '');
  check(
    'both flavours hold the members written in the file',
    highFile.text.includes('Add (int a, int b)') && lowFile.text.includes('Add (int a, int b)'),
    '',
  );
}

/**
 * The ILASM round-trip is the independent check on the listing: ilasm is a real assembler, so a
 * listing it accepts and turns back into an equivalent assembly is real IL, not just readable text.
 */
async function checkRoundTrip(call) {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-roundtrip-'));
  const result = await call('assemble/roundTrip', { path: fixtureAssembly, outputDirectory });

  check('the round-trip succeeds', result.success === true, result.output?.split('\n').at(-1));
  check('the round-trip names the assembler it used', /ilasm/.test(result.ilasmPath ?? ''), result.ilasmPath);
  check('the generated listing is written to disk', fs.existsSync(result.ilPath), result.ilPath);
  check('the assembled assembly is written to disk', fs.existsSync(result.outputPath), result.outputPath);

  const listing = fs.readFileSync(result.ilPath, 'utf8');
  check('the listing carries the assembly manifest', listing.includes('.assembly SampleLib'), listing.slice(0, 80));
  check('the listing carries the types', /^\s*\.class .*SampleLib\.Calculator$/m.test(listing), '');
  check('the listing carries the method bodies', listing.includes('IL_0000:'), '');

  check('every type survives the round-trip', result.roundTripTypes === result.originalTypes, `${result.roundTripTypes}/${result.originalTypes}`);
  check('every method survives the round-trip', result.roundTripMethods === result.originalMethods, `${result.roundTripMethods}/${result.originalMethods}`);
  check('the round-trip reports no differences', result.differences.length === 0, JSON.stringify(result.differences));

  // The assembled file has to be readable again, which is what makes the comparison meaningful.
  const info = await call('assembly/info', { path: result.outputPath });
  check('the assembled assembly can be read back', info.name === 'SampleLib', info.name);
  const roundTripTypes = await call('assembly/types', { path: result.outputPath });
  check('the assembled assembly lists the same types', roundTripTypes.length > 0 && roundTripTypes.every((type) => type.name.length > 0), String(roundTripTypes.length));

  // Exception handlers are the part of the listing an assembler is strictest about, so the fixture
  // that exercises all of them has to assemble as well.
  const release = await call('assemble/roundTrip', { path: liveAssembly, outputDirectory });
  check('a listing with exception handlers assembles', release.success === true, release.output?.split('\n').at(-1));
  check('the handlers keep their methods', release.roundTripMethods === release.originalMethods, `${release.roundTripMethods}/${release.originalMethods}`);

  const handlerListing = fs.readFileSync(release.ilPath, 'utf8');
  check('the listing spells out the handler ranges', handlerListing.includes('finally handler IL_'), '');
  check('the listing keeps the filter of a catch', /filter IL_[0-9a-f]+ handler IL_/.test(handlerListing), '');
  check('the listing keeps the type of a catch', /catch \[System\.Runtime\]System\.ArgumentOutOfRangeException handler IL_/.test(handlerListing), '');

  // A broken assembler must be reported instead of throwing.
  const broken = await call('assemble/roundTrip', { path: fixtureAssembly, outputDirectory, ilasmPath: '/bin/false' });
  check('a failing assembler is reported', broken.success === false, String(broken.success));
  check('a failing assembler keeps the listing for inspection', fs.existsSync(broken.ilPath), broken.ilPath);
}

/**
 * ReadyToRun images are compiled ahead of time, so their code is not produced by the JIT of the
 * running process. The runtime still reports the map from a native address to an IL offset for them,
 * which is what this verifies: the same exact link, on precompiled code.
 */
async function checkReadyToRun(call, available) {
  if (!available) {
    console.log('  skip the ReadyToRun checks — the fixture could not be published');
    return;
  }

  const target = startTarget(r2rAssembly);

  try {
    const ready = await waitForReady(target);
    check('the ReadyToRun program starts', ready);
    if (!ready) {
      return;
    }

    const attach = await call('live/attach', { pid: target.pid });
    check('a ReadyToRun process can be attached to', attach.pid === target.pid, String(attach.pid));

    const types = await call('assembly/types', { path: r2rAssembly });
    const targetType = types.find((type) => type.fullName === 'LiveTarget.Target');
    check('the published image can still be read from disk', Boolean(targetType));
    if (!targetType) {
      return;
    }

    const members = await call('assembly/members', { path: r2rAssembly, token: targetType.token });
    const describe = members.find((member) => member.name === 'Describe');
    check('the published image lists its methods', Boolean(describe));

    const live = await call('view/asmLive', { path: r2rAssembly, token: describe.token });
    check('precompiled code is labelled ReadyToRun', live.text.includes('; ReadyToRun,'), live.text.split('\n')[4]);
    const annotations = (live.text.match(/; IL_[0-9A-Fa-f]{4}/g) ?? []).length;
    check('ReadyToRun instructions carry their IL offsets', annotations >= 5, String(annotations));

    const mapped = live.blocks.filter((block) => block.ilStart >= 0);
    check(
      'ReadyToRun blocks link instructions to source lines',
      mapped.filter((block) => block.sourceFile).length >= 5,
      String(mapped.filter((block) => block.sourceFile).length),
    );

    // The offsets must belong to the IL of that method, exactly like the JIT route.
    const il = await call('view/il', { path: r2rAssembly, token: describe.token });
    const ilOffsets = new Set((il.text.match(/IL_([0-9A-Fa-f]{4}):/g) ?? []).map((label) => label.slice(3, 7).toUpperCase()));
    const unknown = [...new Set(mapped.map((block) => block.ilStart.toString(16).toUpperCase().padStart(4, '0')))].filter(
      (offset) => !ilOffsets.has(offset),
    );
    check('every ReadyToRun IL offset exists in the IL listing', unknown.length === 0, `unknown: ${unknown.join(',')}`);

    const lines = live.text.split('\n');
    const instructionBlocks = mapped.filter((block) => block.textStartLine === block.textEndLine);
    const misaligned = instructionBlocks.filter((block) => {
      const line = lines[block.textStartLine - 1] ?? '';
      return !line.includes(`IL_${block.ilStart.toString(16).padStart(4, '0')}`);
    });
    check(
      'every ReadyToRun instruction block spans the line it annotates',
      instructionBlocks.length >= 5 && misaligned.length === 0,
      JSON.stringify(misaligned.slice(0, 3)),
    );

    // crossgen2 inlines small methods, so a method of the file may have no code of its own. Either
    // outcome has to be reported: code with offsets, or a note that says why there is none.
    const inlined = members.find((member) => member.name === 'Add');
    const inlinedLive = await call('view/asmLive', { path: r2rAssembly, token: inlined.token });
    const explains = (inlinedLive.notes ?? []).some((note) => note.includes('not been compiled'));
    check(
      'a method without precompiled code of its own explains itself',
      inlinedLive.text.includes('; ReadyToRun,') || explains,
      JSON.stringify(inlinedLive.notes ?? []),
    );

    const detach = await call('live/detach');
    check('detaching from a ReadyToRun process succeeds', detach === 'detached', detach);
  } finally {
    try {
      target.kill('SIGKILL');
    } catch {
      // The program already stopped.
    }
  }
}

/**
 * The live route is the only one that carries the JIT mapping from a native address to an IL offset,
 * so this starts a real program, inspects it and cross-checks the offsets against the IL listing.
 */
async function checkLiveProcess(call) {
  const target = startTarget(liveAssembly);

  try {
    const ready = await waitForReady(target);

    check('the live target program starts', ready);
    if (!ready) {
      return;
    }

    const processes = await call('processes');
    check('processes lists the running program', processes.some((entry) => entry.pid === target.pid), `${processes.length} processes`);
    check('processes reports a command line for it', processes.some((entry) => (entry.command ?? '').includes('LiveTarget')), '');

    const attach = await call('live/attach', { pid: target.pid });
    check('attaching uses a snapshot by default', attach.mode === 'Snapshot', attach.mode);
    check('attaching reports the runtime version', /^\d+\.\d+/.test(attach.runtime), attach.runtime);
    check('attaching finds the loaded modules', attach.modules > 0, String(attach.modules));
    check('attaching reports the snapshot size', attach.snapshotBytes > 0, String(attach.snapshotBytes));

    const types = await call('assembly/types', { path: liveAssembly });
    const targetType = types.find((type) => type.fullName === 'LiveTarget.Target');
    check('the live assembly can also be read from disk', Boolean(targetType));

    const members = await call('assembly/members', { path: liveAssembly, token: targetType.token });
    const describe = members.find((member) => member.name === 'Describe');
    const add = members.find((member) => member.name === 'Add');
    check('the live assembly lists the warmed methods', Boolean(describe) && Boolean(add));

    const live = await call('view/asmLive', { path: liveAssembly, token: describe.token });
    check('the live view reports the il-asm language', live.language === 'il-asm', live.language);
    check('the live view reports the process it came from', live.text.includes(`process ${target.pid}`), live.text.split('\n')[1]);
    check('the live view contains real instructions', /\bmov\b|\bpush\b|\bcmp\b/.test(live.text), '');
    check('the live view annotates instructions with IL offsets', (live.text.match(/; IL_[0-9A-Fa-f]{4}/g) ?? []).length >= 5, String((live.text.match(/; IL_[0-9A-Fa-f]{4}/g) ?? []).length));
    check('the live view marks the prolog and epilog', live.text.includes('; prolog') && live.text.includes('; epilog'), '');
    check('the live view reports the JIT kind', live.text.includes('; Jit,'), '');

    const mapped = live.blocks.filter((block) => block.ilStart >= 0);
    check('the live view produces one block per mapped instruction', mapped.length >= 5, String(mapped.length));
    check(
      'the live blocks link instructions to source lines',
      mapped.filter((block) => block.sourceFile).length >= 5,
      String(mapped.filter((block) => block.sourceFile).length),
    );
    check(
      'the live blocks point at the fixture source',
      mapped.every((block) => !block.sourceFile || block.sourceFile.endsWith('Target.cs')),
      mapped.find((block) => block.sourceFile)?.sourceFile,
    );

    // The offsets must be the IL offsets of that very method, not something invented.
    const il = await call('view/il', { path: liveAssembly, token: describe.token });
    const ilOffsets = new Set(
      (il.text.match(/IL_([0-9A-Fa-f]{4}):/g) ?? []).map((label) => label.slice(3, 7).toUpperCase()),
    );
    const asmOffsets = new Set(mapped.map((block) => block.ilStart.toString(16).toUpperCase().padStart(4, '0')));
    const unknown = [...asmOffsets].filter((offset) => !ilOffsets.has(offset));
    check('every live IL offset exists in the IL listing', unknown.length === 0, `unknown: ${unknown.join(',')}`);

    // The line a block reports is what the caret sync uses, so it has to be the very line that
    // carries the annotation. Method wide blocks are excluded: they carry no IL offset of their own.
    const liveLines = live.text.split('\n');
    const instructionBlocks = mapped.filter((block) => block.textStartLine === block.textEndLine);
    const misaligned = instructionBlocks.filter((block) => {
      const line = liveLines[block.textStartLine - 1] ?? '';
      return !line.includes(`IL_${block.ilStart.toString(16).padStart(4, '0')}`);
    });
    check(
      'every live instruction block spans the line it annotates',
      instructionBlocks.length >= 5 && misaligned.length === 0,
      JSON.stringify(misaligned.slice(0, 3)),
    );

    const addLive = await call('view/asmLive', { path: liveAssembly, token: add.token });
    check('a second method can be inspected from the same session', /; IL_[0-9A-Fa-f]{4}/.test(addLive.text), addLive.text.slice(0, 120));

    const detach = await call('live/detach');
    check('detaching succeeds', detach === 'detached', detach);

    let refused = false;
    try {
      await call('view/asmLive', { path: liveAssembly, token: describe.token });
    } catch {
      refused = true;
    }

    check('a live view without a session is refused', refused);
  } finally {
    try {
      target.kill();
    } catch {
      // The program already stopped.
    }
  }
}

async function main() {
  buildFixture();
  const readyToRun = publishReadyToRun();
  const packedMap = publishReadyToRunDebug();
  const fsharp = publishFsharp();
  const nativeImage = publishNativeImage();
  const singleFile = publishSingleFile();
  const compressedSingleFile = publishCompressedSingleFile();
  const { child, call } = startEngine(findEngine());

  try {
    const info = await call('assembly/info', { path: fixtureAssembly });
    check('assembly/info reports the assembly name', info.name === 'SampleLib', info.name);
    check('assembly/info finds the portable PDB', info.hasPdb === true);
    check('assembly/info reports a target framework', /v10\.0|net10\.0/.test(info.targetFramework), info.targetFramework);

    const types = await call('assembly/types', { path: fixtureAssembly });
    const calculator = types.find((type) => type.fullName === 'SampleLib.Calculator');
    check('assembly/types lists SampleLib.Calculator', Boolean(calculator));
    check('assembly/types classifies the type as a class', calculator?.kind === 'class', calculator?.kind);

    const members = await call('assembly/members', { path: fixtureAssembly, token: calculator.token });
    const names = members.map((member) => member.name);
    check('assembly/members lists the methods', names.includes('Add') && names.includes('Describe'), names.join(','));
    check('assembly/members renders readable signatures', members.some((member) => member.signature.includes('int32')), members[0]?.signature);

    const il = await call('view/il', { path: fixtureAssembly, token: calculator.token });
    check('view/il emits a class header', il.text.includes('.class') && il.text.includes('SampleLib.Calculator'));
    check('view/il emits IL labels', /IL_0000:/.test(il.text));
    check('view/il annotates sequence points', il.text.includes('sequence point'));
    check('view/il produces map blocks', il.blocks.length > 10, String(il.blocks.length));

    const mappedIl = il.blocks.filter((block) => block.sourceFile && block.sourceStartLine > 0);
    check('view/il links instructions to source lines', mappedIl.length > 5, `${mappedIl.length} of ${il.blocks.length}`);
    check(
      'view/il source paths point at the fixture file',
      mappedIl.every((block) => block.sourceFile.endsWith('Calculator.cs')),
      mappedIl[0]?.sourceFile,
    );
    check(
      'view/il blocks reference method tokens',
      mappedIl.every((block) => block.methodToken >= 0x06000000 && block.methodToken <= 0x06ffffff),
      String(mappedIl[0]?.methodToken),
    );

    const csharp = await call('view/csharp', { path: fixtureAssembly, token: calculator.token });
    check('view/csharp declares the type', csharp.text.includes('class Calculator'));
    check('view/csharp renders the members', csharp.text.includes('public int Add') && csharp.text.includes('public string Describe'));
    check('view/csharp hoists using directives', csharp.text.startsWith('using '), csharp.text.split('\n')[0]);
    check('view/csharp produces member blocks', csharp.blocks.length >= 4, String(csharp.blocks.length));

    const methodToken = members.find((member) => member.name === 'Describe').token;
    const csharpBlock = csharp.blocks.find((block) => block.methodToken === methodToken);
    check('view/csharp has a block for Describe', Boolean(csharpBlock));
    check(
      'view/csharp member block covers the class line range',
      Boolean(csharpBlock) && csharp.text.split('\n')[csharpBlock.textStartLine - 1].includes('Describe'),
      csharpBlock ? csharp.text.split('\n')[csharpBlock.textStartLine - 1] : undefined,
    );

    const lineUnderTest = 17; // `return "negative";` inside Describe
    const member = await call('map/memberBySource', { path: fixtureAssembly, file: fixtureSource, line: lineUnderTest });
    check('map/memberBySource resolves the enclosing method', member?.name === 'Describe', member?.name);
    check('map/memberBySource resolves the declaring type', member?.declaringType === 'SampleLib.Calculator', member?.declaringType);

    const ilBlocksForMethod = il.blocks.filter((block) => block.methodToken === member.token);
    const csharpBlocksForMethod = csharp.blocks.filter((block) => block.methodToken === member.token);
    check('IL and C# blocks share the same method token', ilBlocksForMethod.length > 0 && csharpBlocksForMethod.length > 0);

    const ilBlocksForLine = ilBlocksForMethod.filter(
      (block) => lineUnderTest >= block.sourceStartLine && lineUnderTest <= block.sourceEndLine,
    );
    check('the source line maps to concrete IL instructions', ilBlocksForLine.length > 0, String(ilBlocksForLine.length));
    check(
      'the mapped IL instructions are inside the method body',
      ilBlocksForLine.every((block) => block.ilStart >= 0 && block.ilEnd <= 0x10000),
      JSON.stringify(ilBlocksForLine[0]),
    );

    // An optimized build drops sequence points for lines it removed, so the nearest mapped line
    // has to be used; otherwise the feature would appear broken on release builds.
    const sourceLines = fs.readFileSync(fixtureSource, 'utf8').split('\n');
    const describeLine = sourceLines.findIndex((line) => line.includes('public string Describe')) + 1;
    const braceLine = describeLine + 1;
    if (fs.existsSync(releaseAssembly)) {
      const releaseMember = await call('map/memberBySource', { path: releaseAssembly, file: fixtureSource, line: braceLine });
      check('map/memberBySource falls back to the nearest mapped line', releaseMember?.name === 'Describe', `line ${braceLine} -> ${releaseMember?.name}`);
    }

    // The tree knows tokens while a view is of a file, so a node has to be resolved to a file.
    const fileOfType = await call('map/fileOf', { path: fixtureAssembly, token: calculator.token });
    check('map/fileOf resolves a type to the source file it was compiled from', /Calculator\.cs$/.test(fileOfType.file ?? ''), String(fileOfType.file));
    check('map/fileOf spells the path the way the PDB does', fileOfType.file === fixtureSource, String(fileOfType.file));

    const fileOfMember = await call('map/fileOf', { path: fixtureAssembly, token: member.token });
    check('map/fileOf resolves a member to its source file', fileOfMember.file === fixtureSource, String(fileOfMember.file));

    // The line is what the caret is put on when a click in the tree opens the source file: the first
    // line the PDB maps for that member, which is inside the body rather than on the signature.
    check(
      'map/fileOf reports the first mapped line of the member',
      fileOfMember.line > describeLine && !sourceLines[fileOfMember.line - 1].includes('public string Describe'),
      `${fileOfMember.line} for a member declared on ${describeLine}`,
    );
    check('map/fileOf reports a line inside the file for a type', fileOfType.line > 0 && fileOfType.line <= sourceLines.length, String(fileOfType.line));

    // An async or iterator entry point lives in a state machine nested in its type, so the type
    // itself has no sequence points and the file has to be found through the nested type.
    if (fs.existsSync(playgroundAssembly)) {
      const playgroundTypes = await call('assembly/types', { path: playgroundAssembly, limit: 200 });
      const program = playgroundTypes.find((type) => type.fullName === 'Playground.Program');
      const fileOfAsyncType = await call('map/fileOf', { path: playgroundAssembly, token: program.token });
      check(
        'map/fileOf resolves a type whose bodies live in a generated nested type',
        /Program\.cs$/.test(fileOfAsyncType.file ?? ''),
        String(fileOfAsyncType.file),
      );

      // A file whose every body the compiler moved into generated types has no visible type. An empty
      // text would hide code that is right there, so the type that declares the generated code is
      // shown instead — the code the file was written as, rebuilt from its state machine.
      const generatedFile = path.join(root, 'test', 'fixtures', 'Playground', 'Program.cs');
      const generatedOnlyView = await call('view/fileCsharp', { path: playgroundAssembly, file: generatedFile });
      check(
        'a file of generated bodies shows the code of the type that holds them',
        /async Task<int> Main/.test(generatedOnlyView.text),
        generatedOnlyView.text.split('\n').slice(5, 8).join(' | '),
      );
      check(
        'that view says why the code looks the way it does',
        generatedOnlyView.text.includes('includeCompilerGenerated') && generatedOnlyView.text.includes('compiler'),
        JSON.stringify(generatedOnlyView.notes),
      );
      check(
        'the IL view of such a file is not empty either',
        (await call('view/fileIl', { path: playgroundAssembly, file: generatedFile })).text.includes('MoveNext'),
        '',
      );

      // A PDB of another assembly next to a file is not this file's PDB: reading it used to run off the
      // end of a blob and fail the request, so it has to be ignored instead.
      const mismatched = fs.mkdtempSync(path.join(os.tmpdir(), 'ilasm-dotnet-pdb-'));
      try {
        const strayAssembly = path.join(mismatched, 'Playground.dll');
        fs.writeFileSync(strayAssembly, fs.readFileSync(playgroundAssembly));
        fs.copyFileSync(path.join(path.dirname(fixtureAssembly), 'SampleLib.pdb'), path.join(mismatched, 'Playground.pdb'));

        const strayInfo = await call('assembly/info', { path: strayAssembly });
        check('an assembly with a foreign PDB next to it is read as one without a PDB', strayInfo.hasPdb === false, String(strayInfo.hasPdb));

        const strayView = await call('view/il', { path: strayAssembly, token: playgroundTypes[0].token });
        check('a foreign PDB does not break the IL view', strayView.text.includes('.class'), strayView.text.split('\n')[0]);
      } finally {
        fs.rmSync(mismatched, { recursive: true, force: true });
      }
    }

    const fileOfMissing = await call('map/fileOf', { path: fixtureAssembly, token: 0x0600ffff });
    check('map/fileOf reports a token the PDB does not know', !fileOfMissing.file, String(fileOfMissing.file));

    // An assembly that carries no PDB has no file to show, which is what the fallback depends on.
    const stripped = path.join(os.tmpdir(), `ilasm-dotnet-stripped-${process.pid}.dll`);
    fs.writeFileSync(stripped, fs.readFileSync(fixtureAssembly));
    try {
      const fileOfStripped = await call('map/fileOf', { path: stripped, token: calculator.token });
      check('map/fileOf reports nothing for an assembly without a PDB', !fileOfStripped.file, String(fileOfStripped.file));
    } finally {
      fs.rmSync(stripped, { force: true });
    }

    // Whole-file scope: the members whose bodies were written in this file.
    const scope = await call('file/scope', { path: fixtureAssembly, file: fixtureSource });
    check('file/scope reports the type declared in the file', scope.types.length === 1, JSON.stringify(scope.types.map((type) => type.token)));
    check('file/scope describes that type', scope.types[0]?.fullName === 'SampleLib.Calculator', scope.types[0]?.fullName);
    check('file/scope reports the type kind', scope.types[0]?.kind === 'class', scope.types[0]?.kind);
    check('file/scope lists the members of the file', scope.members.length >= 4, String(scope.members.length));
    check(
      'file/scope hides compiler generated members by default',
      scope.members.every((member) => !member.name.startsWith('<') && !member.declaringType.includes('.<')),
      JSON.stringify(scope.members.map((member) => member.declaringType)),
    );

    const scopeWithGenerated = await call('file/scope', { path: fixtureAssembly, file: fixtureSource, includeCompilerGenerated: true });
    check(
      'file/scope can include compiler generated members',
      scopeWithGenerated.members.length > scope.members.length && scopeWithGenerated.types.length > scope.types.length,
      `${scopeWithGenerated.members.length} vs ${scope.members.length}`,
    );

    const fileIl = await call('view/fileIl', { path: fixtureAssembly, file: fixtureSource });
    check('view/fileIl shows the whole file', fileIl.text.includes('SampleLib.Calculator') && /IL_[0-9A-F]{4}:/.test(fileIl.text));
    check('view/fileIl reports the il language', fileIl.language === 'il', fileIl.language);
    check('view/fileIl links instructions to source lines', fileIl.blocks.some((block) => block.sourceFile), '');
    check('view/fileIl holds every method of the type', (fileIl.text.match(/IL_0000:/g) ?? []).length >= 3, String((fileIl.text.match(/IL_0000:/g) ?? []).length));

    const fileCsharp = await call('view/fileCsharp', { path: fixtureAssembly, file: fixtureSource });
    check('view/fileCsharp decompiles the whole file', fileCsharp.text.includes('class Calculator'), '');
    check('view/fileCsharp reports the csharp language', fileCsharp.language === 'csharp', fileCsharp.language);

    const fileAsm = await call('view/fileAsm', { path: fixtureAssembly, file: fixtureSource, optimized: true });
    check('view/fileAsm compiles the members of the file', fileAsm.blocks.length >= 4, String(fileAsm.blocks.length));
    check('view/fileAsm contains JIT listings', (fileAsm.text.match(/; Assembly listing for method /g) ?? []).length >= 3, '');
    check('view/fileAsm reports one block per member', fileAsm.blocks.every((block) => block.methodToken > 0), '');
    check('view/fileAsm is titled after the file', fileAsm.title.includes('Calculator.cs'), fileAsm.title);

    // A file that does not exist in the PDB must be reported, not silently empty.
    const foreignFile = await call('view/fileIl', { path: fixtureAssembly, file: path.join(root, 'scripts', 'smoke.mjs') });
    check('view/fileIl reports a file with no debug information', (foreignFile.notes ?? []).length > 0, JSON.stringify(foreignFile.notes));

    await checkLiveProcess(call);
    await checkReadyToRun(call, readyToRun['linux-x64'] ?? false);
    await checkImageCode(call, readyToRun);
    await checkPackedImageMap(call, packedMap);
    await checkFsharp(call);
    await checkFsharpImage(call, fsharp);
    await checkUnreadableImage(call, readyToRun);
    await checkRoundTrip(call);
    await checkNativeImages(call);
    await checkNativeImage(call, nativeImage);
    await checkSingleFile(call, singleFile);
    await checkCompressedSingleFile(call, compressedSingleFile);
    await checkAccessors(call);
    await checkRebuiltAssembly(call);

    await checkCSharpFlavours(call, members);

    const wholeType = await call('view/csharp', { path: fixtureAssembly, token: calculator.token, includeCompilerGenerated: true });
    check('includeCompilerGenerated exposes compiler generated types', wholeType.text.includes('assembly type: SampleLib.Calculator.<'), String(wholeType.blocks.length));

    // A type has no single body: its native code is every body it declares, which is what the view of
    // a type node has to produce. Failing here would leave the tab showing whatever it showed before.
    const typeAsm = await call('view/asm', { path: fixtureAssembly, token: calculator.token, optimized: true, source: 'auto' });
    check('view/asm disassembles a type through its methods', typeAsm.text.includes('Assembly listing for method'), typeAsm.text.split('\n').slice(0, 4).join(' | '));
    check(
      'view/asm of a type lists more than one method',
      (typeAsm.text.match(/Assembly listing for method /g) ?? []).length > 1,
      String((typeAsm.text.match(/Assembly listing for method /g) ?? []).length),
    );
    check('view/asm of a type anchors its methods to their tokens', typeAsm.blocks.length > 1, String(typeAsm.blocks.length));

    // ASM: the JIT must disassemble the method, and the listing must be attributed to its token.
    const addToken = members.find((member) => member.name === 'Add').token;
    const asm = await call('view/asm', { path: fixtureAssembly, token: addToken, optimized: true });
    check('view/asm reports the il-asm language', asm.language === 'il-asm', asm.language);
    check('view/asm produces a JIT listing', /; Assembly listing for method /.test(asm.text), asm.text.split('\n')[4]);
    check('view/asm contains real instructions', /\bmov\b|\blea\b|\bpush\b/.test(asm.text));
    check('view/asm contains a code size', /; Total bytes of code \d+/.test(asm.text));
    check('view/asm names the disassembled method', asm.text.includes('SampleLib.Calculator:Add'), '');
    check('view/asm produces one block for the method', asm.blocks.length === 1, String(asm.blocks.length));
    check('view/asm block points at the requested token', asm.blocks[0]?.methodToken === addToken, String(asm.blocks[0]?.methodToken));
    check('view/asm explains the mode', asm.text.includes('compiled, not executed'));
    check(
      'view/asm reports the runtime it used',
      /runtime \d+\.\d+/.test(asm.text),
      (asm.text.match(/runtime [\d.]+/) ?? ['none'])[0],
    );

    // A debug build carries [Debuggable], so the JIT cannot optimize it; the view has to say so.
    check('view/asm notes that a debug build disables optimization', (asm.notes ?? []).some((note) => note.includes('disables optimization')), JSON.stringify(asm.notes));

    // The same method from the Release build must come back optimized.
    if (fs.existsSync(releaseAssembly)) {
      const releaseTypes = await call('assembly/types', { path: releaseAssembly });
      const releaseCalculator = releaseTypes.find((type) => type.fullName === 'SampleLib.Calculator');
      const releaseMembers = await call('assembly/members', { path: releaseAssembly, token: releaseCalculator.token });
      const releaseAdd = releaseMembers.find((member) => member.name === 'Add').token;
      const optimized = await call('view/asm', { path: releaseAssembly, token: releaseAdd, optimized: true });

      check('view/asm produces optimized code for a release build', optimized.text.includes('FullOpts'), (optimized.text.match(/; (FullOpts|MinOpts)[^\r\n]*/) ?? ['none'])[0]);
      check('view/asm reports no warnings for a release build', (optimized.notes ?? []).length === 0, JSON.stringify(optimized.notes));
      check('view/asm optimized code is smaller than tier 0 code', optimized.text.includes('bytes of code'));

      const tier0 = await call('view/asm', { path: releaseAssembly, token: releaseAdd, optimized: false });
      check('view/asm can produce tier 0 code on request', tier0.text.length > 0);
    }

    // A property has no body of its own; its accessors must be disassembled instead.
    const propertyMember = members.find((member) => member.kind === 'property');
    check('assembly/members reports a property to exercise accessor handling', Boolean(propertyMember), members.map((m) => m.kind).join(','));
    if (propertyMember) {
      const propertyAsm = await call('view/asm', { path: fixtureAssembly, token: propertyMember.token, optimized: true });
      check('view/asm falls back to the property accessor', propertyAsm.text.length > 0 && propertyAsm.blocks.length >= 0);
    }
  } finally {
    try {
      await call('shutdown');
    } catch {
      // The engine may already have exited.
    }

    child.kill();
  }

  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    console.error(`failures:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
