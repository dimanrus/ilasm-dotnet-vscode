import * as vscode from 'vscode';
import { AssemblyLocator } from '../assemblyLocator';
import { EngineClient } from '../engine/client';
import { AssemblyInfo, NativeInfo } from '../engine/protocol';
import { Log } from '../util/log';

/**
 * What the build output of a document turned out to be.
 *
 * A project has one output that matters: its assembly, which every view can read. Two kinds of project
 * have none. One published into a single file keeps its assemblies inside the executable, and the
 * engine reads them by taking the bundle apart - so that file is an assembly as far as the viewer is
 * concerned. One published with NativeAOT has no IL anywhere: the output is an image, and the native
 * route is the only one that can read it. Which of the three it is decides what a command for the
 * current file has to do, so it is asked once and answered in one place.
 */
export type OutputKind =
  | { kind: 'assembly'; assembly: string }
  | { kind: 'native'; info: NativeInfo }
  | { kind: 'unreadable'; message: string }
  | { kind: 'none' };

/**
 * Resolves the output a document belongs to and says what it is.
 *
 * A project leaves several files behind - an assembly, the native image built from it, an executable
 * that starts either - and their names do not say which one can be read. So the candidates are tried
 * newest first and the first readable one wins. A native image whose methods are unknown is passed
 * over: it is the host of an ordinary build or an object left by the AOT compiler, and neither is what
 * a reader asked for when opening a source file of a project that also has an image with symbols.
 */
export async function resolveOutput(
  client: EngineClient,
  locator: AssemblyLocator,
  document: vscode.TextDocument,
): Promise<OutputKind> {
  const candidates = await locator.findCandidatesForDocument(document);
  if (candidates.length === 0) {
    return { kind: 'none' };
  }

  let last: OutputKind = { kind: 'none' };

  for (const candidate of candidates) {
    const classified = await classify(client, candidate);
    if (classified.kind === 'assembly') {
      return classified;
    }

    if (classified.kind === 'native' && classified.info.methodCount > 0) {
      return classified;
    }

    last = classified;
  }

  return last;
}

/** What one file is: an assembly, a native image, or a file neither route can read. */
export async function classify(client: EngineClient, file: string): Promise<OutputKind> {
  try {
    await client.call<AssemblyInfo>('assembly/info', { path: file });
    return { kind: 'assembly', assembly: file };
  } catch (error) {
    // A file that is no assembly may be a native image, and then there is machine code to show even
    // though there is no IL. When that fails too, the reason the metadata reader gave is what is left.
    const native = await client.call<NativeInfo>('native/info', { path: file }).catch(() => undefined);
    if (native) {
      return { kind: 'native', info: native };
    }

    Log.info(`[outputs] ${file} is neither an assembly nor a native image`);
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
}
