import * as path from 'path';
import * as vscode from 'vscode';
import { AssemblyLocator, isSourceFile } from '../assemblyLocator';
import { EngineClient } from '../engine/client';
import { resolveOutput } from '../viewer/outputs';
import { AssemblyInfo, FileScope, MemberLocation, NativeInfo, NativeMethod, TypeInfo } from '../engine/protocol';
import { Log } from '../util/log';

type TreeNode = CurrentFileNode | AssemblyNode | NativeImageNode | NativeMethodNode | TypeNode | MemberNode;

/** A member as the tree needs it, whether it came from the project listing or the file scope. */
export interface TreeMember {
  token: number;
  name: string;
  kind: string;
  signature?: string;
  declaringType: string;
}

/** The file in the active editor, with everything the portable PDB attributes to it. */
interface CurrentFileNode {
  kind: 'currentfile';
  file: string;
  assembly?: string;
  scope?: FileScope;
  /** Set when the build output is a native image, whose methods are what the file was compiled into. */
  native?: NativeMethod[];
  /** Explains why the section is empty, for example because the project has not been built. */
  problem?: string;
}

interface AssemblyNode {
  kind: 'assembly';
  info: AssemblyInfo;
  /** Explains why the assembly cannot be read, for a file that turned out not to be a managed one. */
  problem?: string;
}

/**
 * A native image: a NativeAOT application or an ordinary native library. It has no IL and no
 * metadata to decompile, so the tree lists the methods the debug information found in it instead of
 * the types of an assembly.
 */
interface NativeImageNode {
  kind: 'nativeimage';
  info: NativeInfo;
}

interface NativeMethodNode {
  kind: 'nativemethod';
  assembly: string;
  method: NativeMethod;
}

interface TypeNode {
  kind: 'type';
  assembly: string;
  info: TypeInfo;
  /** Set for types listed through the current file: only that file's members are shown below. */
  fileMembers?: MemberLocation[];
}

interface MemberNode {
  kind: 'member';
  assembly: string;
  info: TreeMember;
}

/**
 * How many methods of a native image the tree lists. An AOT image holds thousands, most of them from
 * the runtime it was built with, and a list nobody can read is no better than an empty one.
 */
const NativeMethodLimit = 500;

/**
 * Side bar tree with two sections: the file currently open in the editor, then every assembly found
 * in the workspace. The current-file section answers "what is in this file" without having to find
 * the project output by hand, and it follows the active editor.
 */
export class AssemblyTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly extraAssemblies = new Set<string>();

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly client: EngineClient,
    private readonly locator: AssemblyLocator,
    private readonly includeCompilerGenerated: () => boolean,
    private readonly nativeRuntimeMethods: () => boolean,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  addAssembly(assemblyPath: string): void {
    this.extraAssemblies.add(assemblyPath);
    this.refresh();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'currentfile':
        return this.currentFileItem(element);
      case 'assembly':
        return this.assemblyItem(element);
      case 'nativeimage':
        return this.nativeImageItem(element);
      case 'nativemethod':
        return this.nativeMethodItem(element);
      case 'type':
        return this.typeItem(element);
      default:
        return this.memberItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!element) {
        return await this.rootNodes();
      }

      switch (element.kind) {
        case 'currentfile':
          if (element.native) {
            return element.native.map((method) => ({
              kind: 'nativemethod' as const,
              assembly: element.assembly ?? '',
              method,
            }));
          }

          return (element.scope?.types ?? []).map((info) => ({
            kind: 'type' as const,
            assembly: element.assembly ?? '',
            info,
            fileMembers: (element.scope?.members ?? []).filter((member) => member.typeToken === info.token),
          }));

        case 'nativeimage':
          return await this.nativeMethodsOf(element);

        case 'nativemethod':
          return [];

        case 'assembly': {
          if (element.problem) {
            return [];
          }

          const types = await this.client.call<TypeInfo[]>('assembly/types', {
            path: element.info.path,
            limit: 5000,
          });

          return types
            .filter((type) => this.isVisible(type.name, type.fullName))
            .map((info) => ({ kind: 'type' as const, assembly: element.info.path, info }));
        }

        case 'type':
          return await this.membersOf(element);

        default:
          return [];
      }
    } catch (error) {
      Log.error('loading the ILASM Dotnet tree failed', error);
      return [];
    }
  }

  private async membersOf(element: TypeNode): Promise<TreeNode[]> {
    if (element.fileMembers) {
      // Types listed under the current file show only the bodies written in that file.
      return element.fileMembers
        .filter((member) => this.isVisible(member.name, member.declaringType))
        .map((member) => ({
          kind: 'member' as const,
          assembly: element.assembly,
          info: {
            token: member.token,
            name: member.name,
            kind: member.kind,
            declaringType: member.declaringType,
          },
        }));
    }

    const members = await this.client.call<TreeMember[]>('assembly/members', {
      path: element.assembly,
      token: element.info.token,
    });

    return members
      .filter((member) => this.isVisible(member.name, member.name))
      .map((info) => ({ kind: 'member' as const, assembly: element.assembly, info }));
  }

  private async rootNodes(): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    const current = await this.currentFileNode();
    if (current) {
      nodes.push(current);
    }

    const paths = new Set<string>(this.extraAssemblies);
    for (const project of await this.locator.discoverProjects()) {
      paths.add(project.assemblyPath);
    }

    for (const assemblyPath of paths) {
      try {
        const info = await this.client.call<AssemblyInfo>('assembly/info', { path: assemblyPath });
        nodes.push({ kind: 'assembly', info });
      } catch (error) {
        Log.error(`reading ${assemblyPath} failed`, error);

        // A file that is no assembly may still be a native image, which the native route can read:
        // it is the one case where the failure of the metadata reader is not the end of the story.
        const native = await this.client
          .call<NativeInfo>('native/info', { path: assemblyPath })
          .catch(() => undefined);

        if (native) {
          nodes.push({ kind: 'nativeimage', info: native });
          continue;
        }

        // The path stays visible with the reason it could not be read, because a silently missing
        // entry is what a wrong path or a native image looks like otherwise.
        const message = error instanceof Error ? error.message : String(error);
        nodes.push({
          kind: 'assembly',
          info: {
            path: assemblyPath,
            name: path.basename(assemblyPath),
            version: '',
            targetFramework: '',
            architecture: '',
            isExecutable: false,
            hasPdb: false,
            typeCount: 0,
          },
          problem: message,
        });
      }
    }

    return nodes;
  }

  /**
   * Resolves the active editor's file to its build output and asks the engine what it contains.
   * A file that cannot be mapped still gets a node, so the reason is visible in the tree.
   */
  private async currentFileNode(): Promise<CurrentFileNode | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }

    const file = editor.document.uri.fsPath;
    if (!isSourceFile(file)) {
      return undefined;
    }

    const output = await resolveOutput(this.client, this.locator, editor.document);
    if (output.kind === 'none') {
      return { kind: 'currentfile', file, problem: 'no build output found — build the project' };
    }

    if (output.kind === 'unreadable') {
      return { kind: 'currentfile', file, problem: output.message };
    }

    // The output of a project published with NativeAOT is no assembly at all: the file is machine
    // code, and the methods compiled from this one source file are what the section can list.
    if (output.kind === 'native') {
      const native = await this.nativeMethodsOfFile(output.info.path, file);
      return native
        ? { kind: 'currentfile', file, assembly: output.info.path, native }
        : { kind: 'currentfile', file, assembly: output.info.path, problem: output.info.note ?? 'the image has no method with source information' };
    }

    const assembly = output.assembly;

    try {
      const scope = await this.client.call<FileScope>('file/scope', {
        path: assembly,
        file,
        includeCompilerGenerated: this.includeCompilerGenerated(),
      });

      if (scope.types.length === 0) {
        return {
          kind: 'currentfile',
          file,
          assembly,
          scope,
          problem: 'this file is not described by the debug information',
        };
      }

      return { kind: 'currentfile', file, assembly, scope };
    } catch (error) {
      Log.error(`reading the scope of ${file} failed`, error);

      // When the assembly cannot be read after all, the reason is what makes the node useful instead
      // of an entry that says nothing.
      return {
        kind: 'currentfile',
        file,
        assembly,
        problem: error instanceof Error ? error.message : 'could not read the assembly',
      };
    }
  }

  private currentFileItem(node: CurrentFileNode): vscode.TreeItem {
    const fileName = path.basename(node.file);
    const collapsible =
      (node.scope?.types.length ?? 0) > 0 || (node.native?.length ?? 0) > 0;
    const item = new vscode.TreeItem(fileName, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

    const typeCount = node.scope?.types.length ?? 0;
    const memberCount = node.scope?.members.length ?? 0;
    const methodCount = node.native?.length ?? 0;
    item.description =
      node.problem ??
      (methodCount > 0
        ? `native image · ${methodCount} method(s) in this file`
        : `${typeCount} type(s) · ${memberCount} member(s)`);
    item.tooltip = new vscode.MarkdownString(
      `**${fileName}**\n\n${node.file}\n\n${
        node.problem ??
        (methodCount > 0
          ? `Compiled into ${methodCount} method(s) of a native image`
          : `Declared here: ${typeCount} type(s), ${memberCount} member(s)`)
      }`,
    );
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'ilasmDotnet.currentFile';

    if (node.assembly) {
      item.command = {
        command: 'ilasmDotnet.showPanel',
        title: 'Open in ILASM Dotnet',
        arguments: [{ assembly: node.assembly, file: node.file }],
      };
    }

    return item;
  }

  /** Methods of a source file that was compiled into a native image, or nothing when that is not it. */
  private async nativeMethodsOfFile(assembly: string, file: string): Promise<NativeMethod[] | undefined> {
    const methods = await this.client
      .call<NativeMethod[]>('native/methods', { path: assembly, file, includeRuntime: this.nativeRuntimeMethods() })
      .catch(() => undefined);

    return methods && methods.length > 0 ? methods : undefined;
  }

  /**
   * The methods of a native image. The order the engine returns puts the methods whose source is on
   * this machine first, so the list starts with the code the reader can navigate to.
   */
  private async nativeMethodsOf(node: NativeImageNode): Promise<TreeNode[]> {
    const methods = await this.client.call<NativeMethod[]>('native/methods', {
      path: node.info.path,
      includeRuntime: this.nativeRuntimeMethods(),
    });

    return methods
      .slice(0, NativeMethodLimit)
      .map((method) => ({ kind: 'nativemethod' as const, assembly: node.info.path, method }));
  }

  private nativeMethodItem(node: NativeMethodNode): vscode.TreeItem {
    const method = node.method;
    const source = method.file ? `${path.basename(method.file)}:${method.line}` : 'no source line';

    const item = new vscode.TreeItem(method.fullName, vscode.TreeItemCollapsibleState.None);
    item.description = source;
    item.tooltip = new vscode.MarkdownString(
      `**${method.fullName}**\n\n${method.symbol}\n\n${method.size} bytes at 0x${method.address.toString(16)}` +
        (method.file ? `\n\n${method.file}:${method.line}` : ''),
    );
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.contextValue = 'ilasmDotnet.nativeMethod';
    item.command = {
      command: 'ilasmDotnet.openInViewer',
      title: 'Open in ILASM Dotnet',
      arguments: [{ assembly: node.assembly, native: true, file: method.file, address: method.address }],
    };
    return item;
  }

  private nativeImageItem(node: NativeImageNode): vscode.TreeItem {
    const details = [`native image · ${node.info.machine}`];
    details.push(node.info.methodCount === 1 ? '1 method' : `${node.info.methodCount} methods`);
    if (!node.info.hasDebugInfo) {
      details.push('no debug information');
    }

    const item = new vscode.TreeItem(node.info.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = details.join(' · ');
    item.tooltip = new vscode.MarkdownString(
      `**${node.info.name}**\n\n${node.info.path}\n\n${node.info.methodCount} methods, ${node.info.runtimeMethodCount} of them from the runtime` +
        (node.info.debugFile ? `\n\nDebug information: ${node.info.debugFile}` : '') +
        (node.info.note ? `\n\n${node.info.note}` : ''),
    );
    item.iconPath = new vscode.ThemeIcon(node.info.hasDebugInfo ? 'file-binary' : 'warning');
    item.contextValue = 'ilasmDotnet.nativeImage';
    return item;
  }

  private assemblyItem(node: AssemblyNode): vscode.TreeItem {
    if (node.problem) {
      const item = new vscode.TreeItem(node.info.name, vscode.TreeItemCollapsibleState.None);
      item.description = node.problem;
      item.tooltip = new vscode.MarkdownString(`**${node.info.name}**\n\n${node.info.path}\n\n${node.problem}`);
      item.iconPath = new vscode.ThemeIcon('warning');
      item.contextValue = 'ilasmDotnet.assembly';
      return item;
    }

    const details = [node.info.version, node.info.targetFramework, node.info.architecture]
      .filter((value) => value && value.length > 0)
      .join(' · ');

    const item = new vscode.TreeItem(node.info.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = details;
    item.tooltip = new vscode.MarkdownString(
      `**${node.info.name}**\n\n${node.info.path}\n\n${node.info.typeCount} types · ${node.info.hasPdb ? 'PDB found' : 'no PDB'}`,
    );
    item.iconPath = new vscode.ThemeIcon('file-binary');
    item.contextValue = 'ilasmDotnet.assembly';
    return item;
  }

  private typeItem(node: TypeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.info.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = node.info.kind;
    item.tooltip = node.info.fullName;
    item.iconPath = new vscode.ThemeIcon(iconForType(node.info.kind));
    item.contextValue = 'ilasmDotnet.type';
    // The node stands for a type of an assembly, so a click shows its code in the single tab, with
    // the switcher offering IL and ASM of the same member.
    item.command = {
      command: 'ilasmDotnet.openInViewer',
      title: 'Open in ILASM Dotnet',
      arguments: [{ assembly: node.assembly, token: node.info.token, title: node.info.fullName, isType: true }],
    };

    return item;
  }

  private memberItem(node: MemberNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.info.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.info.signature || node.info.kind;
    item.tooltip = node.info.signature ?? node.info.name;
    item.iconPath = new vscode.ThemeIcon(iconForMember(node.info.kind));
    item.contextValue = 'ilasmDotnet.member';
    item.command = {
      command: 'ilasmDotnet.openInViewer',
      title: 'Open in ILASM Dotnet',
      arguments: [
        {
          assembly: node.assembly,
          token: node.info.token,
          title: `${node.info.declaringType}.${node.info.name}`,
          revealMethodToken: node.info.token,
        },
      ],
    };

    return item;
  }

  private isVisible(name: string, fullName: string): boolean {
    if (this.includeCompilerGenerated()) {
      return true;
    }

    // Compiler generated members and nested state machines carry angle brackets, and a generated
    // nested type reads as Namespace.Type.<State>d__5 rather than starting with a bracket.
    return (
      !name.startsWith('<') &&
      !name.includes('.<') &&
      !fullName.includes('+<') &&
      !fullName.includes('.<')
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function iconForType(kind: string): string {
  switch (kind) {
    case 'interface':
      return 'symbol-interface';
    case 'struct':
      return 'symbol-structure';
    case 'enum':
      return 'symbol-enum';
    default:
      return 'symbol-class';
  }
}

function iconForMember(kind: string): string {
  switch (kind) {
    case 'field':
      return 'symbol-field';
    case 'property':
      return 'symbol-property';
    case 'event':
      return 'symbol-event';
    case 'constructor':
    case 'static constructor':
      return 'symbol-constructor';
    default:
      return 'symbol-method';
  }
}
