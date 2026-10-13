/**
 * State and request mapping for the single viewer tab. This module deliberately has no dependency
 * on the VS Code API so the switching rules can be unit tested on their own.
 */

import { ilLabel } from './mapping';

export type ViewerKind = 'il' | 'csharp' | 'csharpLow' | 'asm';

/** `file` means the whole source file, anything else is a member metadata token. */
export const FILE_SCOPE = 'file';

export const KIND_ORDER: ViewerKind[] = ['il', 'csharp', 'csharpLow', 'asm'];

export const KIND_LABELS: Record<ViewerKind, string> = {
  il: 'IL code',
  csharp: 'C# (high level)',
  csharpLow: 'C# (low level)',
  asm: 'Native ASM',
};

/** Language the document is switched to; this is what drives syntax highlighting. */
export const KIND_LANGUAGE: Record<ViewerKind, string> = {
  il: 'il',
  csharp: 'csharp',
  csharpLow: 'csharp',
  asm: 'il-asm',
};

export interface ViewerSession {
  assembly: string;
  file: string;
  kind: ViewerKind;
  scope: string;
  /**
   * True when the assembly is a native image. Such an image has no IL and no metadata to decompile,
   * so machine code is the only view it can have; the switcher offers nothing else for it.
   */
  native?: boolean;
}

/** The views an assembly can be shown in: a native image has only its machine code. */
export function kindsFor(session: ViewerSession): ViewerKind[] {
  return session.native ? ['asm'] : KIND_ORDER;
}

/** A member of the file, as the file scope reports it. */
export interface ScopeMember {
  token: number;
  kind: string;
  name: string;
  declaringType: string;
  /** Property or event an accessor stands for, when the member is one. */
  owner?: string | null;
  /** Role the accessor plays in it: get, set, add or remove. */
  accessor?: string | null;
  /**
   * Address of the machine code, for a method of a native image. A native method has no token, so
   * its address is the handle the session carries in its scope.
   */
  address?: number;
  /** Label to show instead of the name, for a member whose name alone does not identify it. */
  label?: string;
  /** Second line of the entry, for example the file and line a native method was compiled from. */
  detail?: string;
}

export interface EngineRequest {
  method: string;
  params: Record<string, unknown>;
}

/** One entry of the clickable row shown above the code. */
export interface LensSpec {
  title: string;
  command: string;
  arguments: unknown[];
  active: boolean;
}

export interface ScopeChoice {
  value: string;
  label: string;
  description: string;
}

export function isViewerKind(value: unknown): value is ViewerKind {
  return typeof value === 'string' && (KIND_ORDER as string[]).includes(value);
}

export function languageFor(kind: ViewerKind): string {
  return KIND_LANGUAGE[kind];
}

export function isWholeFile(session: ViewerSession): boolean {
  return session.scope === FILE_SCOPE;
}

/** Builds the engine call for the current state, choosing the file or the member endpoint. */
export function requestFor(
  session: ViewerSession,
  options: {
    includeCompilerGenerated: boolean;
    optimized: boolean;
    live?: boolean;
    asmSource?: string;
    nativeIncludeRuntime?: boolean;
  },
): EngineRequest {
  const live = options.live === true;

  // A native image is read by the route of its own: it has no tokens, so a method is named by the
  // address of its code, and the whole-file scope is the set of methods one file was compiled into.
  if (session.native) {
    const params: Record<string, unknown> = {
      path: session.assembly,
      includeRuntime: options.nativeIncludeRuntime === true,
    };

    if (isWholeFile(session)) {
      params.file = session.file;
    } else {
      params.address = Number(session.scope);
    }

    return { method: 'native/asm', params };
  }

  if (isWholeFile(session)) {
    const method =
      session.kind === 'il' ? 'view/fileIl'
      : isCSharp(session.kind) ? 'view/fileCsharp'
      : live ? 'view/fileAsmLive'
      : 'view/fileAsm';

    return {
      method,
      params: {
        path: session.assembly,
        file: session.file,
        ...csharpParams(session.kind, options),
        optimized: options.optimized,
        source: options.asmSource,
      },
    };
  }

  // The live route is the only one that reports an IL offset per instruction, so it is preferred
  // whenever a process is attached.
  const method =
    session.kind === 'il' ? 'view/il'
    : isCSharp(session.kind) ? 'view/csharp'
    : live ? 'view/asmLive'
    : 'view/asm';
  return {
    method,
    params: {
      path: session.assembly,
      token: Number(session.scope),
      ...csharpParams(session.kind, options),
      optimized: options.optimized,
      source: options.asmSource,
    },
  };
}

/** Both C# flavours come from the same request, only the settings of the decompiler differ. */
export function isCSharp(kind: ViewerKind): boolean {
  return kind === 'csharp' || kind === 'csharpLow';
}

/**
 * The low-level flavour always shows the compiler generated members: they are the point of it, which
 * is also why it does not follow the setting that hides them in the high-level one.
 */
function csharpParams(
  kind: ViewerKind,
  options: { includeCompilerGenerated: boolean; lowLevel?: boolean },
): Record<string, unknown> {
  return isCSharp(kind)
    ? { includeCompilerGenerated: options.includeCompilerGenerated || kind === 'csharpLow', lowLevel: kind === 'csharpLow' }
    : { includeCompilerGenerated: options.includeCompilerGenerated };
}

/** Identity of a fetched view, used as a cache key so switching back does not recompile ASM. */
export function cacheKey(session: ViewerSession, options: CacheKeyOptions = {}): string {
  const kind = session.kind === 'asm' ? `asm:${options.live ? 'live' : options.asmSource ?? 'auto'}` : session.kind;

  // A native view is one of two lists of methods: the application's own, or every method including
  // those of the runtime it was built with.
  const native = session.native ? `:native${options.nativeIncludeRuntime ? ':all' : ':own'}` : '';

  // The settings that change what a request returns have to be part of the key, otherwise a pane
  // would keep showing the view it was opened with after a setting changed.
  const generated = isCSharp(session.kind) ? `:${options.includeCompilerGenerated ? 'generated' : 'plain'}` : '';
  const optimized = session.kind === 'asm' ? `:${options.optimized === false ? 'tiered' : 'optimized'}` : '';

  return `${session.assembly}|${session.file}|${kind}${native}${generated}${optimized}|${session.scope}`;
}

/** What a fetched view depends on besides the session itself: the settings and the live process. */
export interface CacheKeyOptions {
  live?: boolean;
  asmSource?: string;
  includeCompilerGenerated?: boolean;
  optimized?: boolean;
  nativeIncludeRuntime?: boolean;
}

export function memberLabel(member: ScopeMember): string {
  // A member that knows how it wants to be named says so: a method of a native image is identified
  // by the type it belongs to and not by a token, and its name alone would be ambiguous.
  if (member.label) {
    return member.label;
  }

  // An accessor is listed under the property or event it belongs to, because that is the member C#
  // can express and the one the C# views show for it.
  if (member.owner && member.accessor) {
    return `${member.owner} (${member.accessor})`;
  }

  if (member.kind === 'constructor') {
    const typeName = member.declaringType.split('.').pop() ?? member.declaringType;
    return `${typeName}()`;
  }

  return `${member.name}()`;
}

export function scopeLabel(session: ViewerSession, members: ScopeMember[]): string {
  if (isWholeFile(session)) {
    return 'Entire file';
  }

  const member = members.find((candidate) => scopeValueOf(candidate) === session.scope);
  return member ? memberLabel(member) : 'Member';
}

/**
 * Options for the scope picker: the whole file first, then every member of the file. A session that
 * was opened for a member of an assembly without a PDB has no file to offer, so the whole-file entry
 * is left out rather than presented as a choice that could only fail.
 */
export function scopeChoices(members: ScopeMember[], options: { wholeFile?: boolean } = {}): ScopeChoice[] {
  const wholeFile: ScopeChoice[] =
    options.wholeFile === false
      ? []
      : [{ value: FILE_SCOPE, label: 'Entire file', description: 'every type declared in this file' }];

  return [
    ...wholeFile,
    ...members.map((member) => ({
      value: scopeValueOf(member),
      label: memberLabel(member),
      description: member.detail ?? member.declaringType,
    })),
  ];
}

/**
 * The clickable row above the code: one entry per view plus the scope picker. A real dropdown cannot
 * live inside a VS Code editor, so this row is the native equivalent.
 */
export function lensSpecs(session: ViewerSession, members: ScopeMember[]): LensSpec[] {
  const lenses: LensSpec[] = kindsFor(session).map((kind) => ({
    title: kind === session.kind ? `● ${KIND_LABELS[kind]}` : KIND_LABELS[kind],
    command: 'ilasmDotnet.selectKind',
    arguments: [kind],
    active: kind === session.kind,
  }));

  lenses.push({
    title: `Scope: ${scopeLabel(session, members)}`,
    command: 'ilasmDotnet.selectScope',
    arguments: [],
    active: false,
  });

  return lenses;
}

/**
 * How the offset of an instruction is spelled. A managed view reports IL offsets, which are labelled
 * the way the disassembler prints them; a native image has no IL, so the address itself is what
 * identifies an instruction.
 */
export function instructionLabel(session: ViewerSession | undefined, value: number): string {
  return session?.native ? `0x${value.toString(16)}` : ilLabel(value);
}

/** What a session carries in its scope for a member: the address of native code, or a token. */
export function scopeValueOf(member: ScopeMember): string {
  return member.address === undefined ? String(member.token) : String(member.address);
}

/** Text for the status bar entry, which is the second way to reach the switcher. */
export function statusText(session: ViewerSession, members: ScopeMember[], livePid?: number): string {
  const parts = [KIND_LABELS[session.kind], scopeLabel(session, members), fileNameOf(session)].filter(
    (part) => part.length > 0,
  );

  if (livePid !== undefined) {
    parts.push(`live ${livePid}`);
  }

  return parts.join(' · ');
}

/** Short label for the document subtitle line, for example `Catalog.cs — ASM`. */
export function subtitleFor(session: ViewerSession, members: ScopeMember[]): string {
  return [fileNameOf(session), KIND_LABELS[session.kind], scopeLabel(session, members)]
    .filter((part) => part.length > 0)
    .join(' · ');
}

/** Name of the file a session shows, or nothing when it is about a member of a stripped assembly. */
function fileNameOf(session: ViewerSession): string {
  return session.file.split(/[\\/]/).pop() ?? session.file;
}
