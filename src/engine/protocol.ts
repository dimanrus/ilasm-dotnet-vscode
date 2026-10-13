/** Mirror of the DTOs exposed by the .NET engine. */

export interface AssemblyInfo {
  path: string;
  name: string;
  version: string;
  targetFramework: string;
  architecture: string;
  isExecutable: boolean;
  hasPdb: boolean;
  typeCount: number;
}

export interface TypeInfo {
  token: number;
  name: string;
  namespace: string;
  fullName: string;
  kind: string;
  accessibility: string;
  memberCount: number;
  nestedTypeCount: number;
}

/**
 * What a native image is: a NativeAOT binary or an ordinary native library, with the machine it was
 * built for and whether the debug information that ties its code to source lines was found.
 */
export interface NativeInfo {
  path: string;
  name: string;
  machine: string;
  hasDebugInfo: boolean;
  debugFile?: string | null;
  methodCount: number;
  runtimeMethodCount: number;
  note?: string | null;
}

/** One method of a native image: the code it owns, and the source line the debug information names. */
export interface NativeMethod {
  address: number;
  size: number;
  name: string;
  fullName: string;
  declaringType: string;
  file: string;
  line: number;
  symbol: string;
  isRuntime: boolean;
}

export interface MemberInfo {
  token: number;
  name: string;
  kind: string;
  signature: string;
  declaringType: string;
}

/**
 * A run of view text sharing one anchor. `methodToken` plus `ilStart`/`ilEnd` link the IL and C#
 * views to each other, while `sourceFile`/`sourceStartLine`/`sourceEndLine` link them to the
 * original source the PDB points at.
 */
export interface MapBlock {
  methodToken: number;
  ilStart: number;
  ilEnd: number;
  textStartLine: number;
  textEndLine: number;
  sourceFile?: string;
  sourceStartLine: number;
  sourceEndLine: number;
}

export interface ViewInfo {
  title: string;
  language: string;
  text: string;
  hasDebugInfo: boolean;
  blocks: MapBlock[];
  /** Diagnostics the engine wants to surface, for example when the JIT produced no code. */
  notes?: string[];
}

export interface MemberLocation {
  token: number;
  typeToken: number;
  kind: string;
  name: string;
  declaringType: string;
  sourceLine: number;
  /** Property or event an accessor stands for, when the member is one. */
  owner?: string | null;
  /** Role the accessor plays in it: get, set, add or remove. */
  accessor?: string | null;
}

/** Source of a metadata token, as the engine resolves it from the PDB. */
export interface FileOf {
  /** Absent when the PDB does not know the token. */
  file?: string | null;
  /** First line of that token in the file, for placing the caret on it. */
  line?: number;
}

/** A .NET process that can be inspected with the diagnostic runtime. */
export interface LiveProcess {
  pid: number;
  name: string;
  path: string;
  command: string;
}

/** Result of attaching the viewer to a running process. */
export interface LiveAttachResult {
  pid: number;
  mode: string;
  runtime: string;
  modules: number;
  snapshotBytes: number;
  detail: string;
}

/** What ilasm produced for the listing the viewer shows. */
export interface RoundTripResult {
  success: boolean;
  ilPath: string;
  outputPath: string;
  ilasmPath: string;
  output: string;
  originalTypes: number;
  roundTripTypes: number;
  originalMethods: number;
  roundTripMethods: number;
  differences: string[];
}

/** What a source file contains, as reported by the portable PDB. */
export interface FileScope {
  file: string;
  types: TypeInfo[];
  members: MemberLocation[];
}
