import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Log } from './util/log';

export interface ProjectAssembly {
  projectPath: string;
  projectName: string;
  assemblyPath: string;
  lastWrite: number;
}

const PROJECT_FILES = ['csproj', 'fsproj', 'vbproj'];

/**
 * The languages of a .NET project. The viewer reads an assembly, and a project file is only how the
 * assembly of a source file is found, so every one of them is a way in: C#, F# and VB all compile
 * into the same metadata, and the decompiled C# of an F# or VB assembly is what the C# pane shows.
 */
const SOURCE_EXTENSIONS = ['.cs', '.fs', '.vb'];

/** Whether a file is the source of a .NET project, whatever language it was written in. */
export function isSourceFile(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Finds the build output that belongs to a source file: the nearest project file defines the
 * assembly name, and the newest matching DLL under `bin` is the one the file was compiled into.
 */
export class AssemblyLocator {
  private readonly cache = new Map<string, ProjectAssembly | undefined>();

  invalidate(): void {
    this.cache.clear();
  }

  async findForDocument(document: vscode.TextDocument): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const searchRoot = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const project = await this.findProject(path.dirname(document.uri.fsPath), searchRoot);
    if (!project) {
      return undefined;
    }

    const cached = this.cache.get(project.dir);
    if (cached !== undefined) {
      return cached?.assemblyPath;
    }

    const name = await this.readAssemblyName(project.file) ?? path.basename(project.file, path.extname(project.file));
    const assembly = await this.findNewestOutput(project.dir, project.file, name);
    this.cache.set(project.dir, assembly);

    if (!assembly) {
      Log.info(`[locator] no build output named ${name}.dll or ${name} under ${project.dir}`);
    }

    return assembly?.assemblyPath;
  }

  /** Projects of the workspace, used to populate the assemblies view. */
  async discoverProjects(limitPerProject = 1): Promise<ProjectAssembly[]> {
    const found = await vscode.workspace.findFiles(`**/*.{${PROJECT_FILES.join(',')}}`, '**/{bin,obj,node_modules,.git}/**', 200);
    const results: ProjectAssembly[] = [];

    for (const projectFile of found) {
      const dir = path.dirname(projectFile.fsPath);
      const name = await this.readAssemblyName(projectFile.fsPath) ?? path.basename(projectFile.fsPath, path.extname(projectFile.fsPath));
      const outputs = await this.findOutputs(dir, projectFile.fsPath, name, limitPerProject);
      results.push(...outputs);
    }

    return results.sort((left, right) => right.lastWrite - left.lastWrite);
  }

  /** Whether the project is published ahead of time, which is what decides what its output is. */
  private async readPublishAot(projectFile: string): Promise<boolean> {
    try {
      const content = await fs.promises.readFile(projectFile, 'utf8');
      return /<PublishAot>\s*true\s*<\/PublishAot>/i.test(content);
    } catch (error) {
      Log.error(`reading ${projectFile} failed`, error);
      return false;
    }
  }

  private async findProject(startDirectory: string, boundary: string): Promise<{ dir: string; file: string } | undefined> {
    let current = startDirectory;
    for (let depth = 0; depth < 12; depth++) {
      for (const extension of PROJECT_FILES) {
        const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(current, `*.${extension}`), null, 1);
        if (matches.length > 0) {
          return { dir: current, file: matches[0].fsPath };
        }
      }

      const parent = path.dirname(current);
      if (parent === current || !isInside(parent, boundary)) {
        return undefined;
      }

      current = parent;
    }

    return undefined;
  }

  private async readAssemblyName(projectFile: string): Promise<string | undefined> {
    try {
      const content = await fs.promises.readFile(projectFile, 'utf8');
      const match = /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(content);
      return match?.[1].trim();
    } catch (error) {
      Log.error(`reading ${projectFile} failed`, error);
      return undefined;
    }
  }

  /**
   * Every output of the document's project, newest first. A project can leave several behind - a
   * native image beside the intermediate dll it was compiled from, an executable beside both - and
   * which of them can be read is not something the file names say: the caller tries them in turn.
   */
  async findCandidatesForDocument(document: vscode.TextDocument, limit = 4): Promise<string[]> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const searchRoot = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const project = await this.findProject(path.dirname(document.uri.fsPath), searchRoot);
    if (!project) {
      return [];
    }

    const name = await this.readAssemblyName(project.file) ?? path.basename(project.file, path.extname(project.file));
    const outputs = await this.findOutputs(project.dir, project.file, name, limit);
    return outputs.map((output) => output.assemblyPath);
  }

  private async findNewestOutput(projectDirectory: string, projectFile: string, assemblyName: string): Promise<ProjectAssembly | undefined> {
    const outputs = await this.findOutputs(projectDirectory, projectFile, assemblyName, 1);
    return outputs[0];
  }

  /**
   * What the project builds into. The output of a project is normally its assembly, and that is what a
   * reader wants even though a native executable always sits next to it - the host of an ordinary
   * build does nothing but start the dll.
   *
   * Two kinds of project have no assembly that matters. One published with NativeAOT keeps an
   * intermediate dll in `bin`, but its real output is the image: the dll is the IL the image was made
   * from, and showing its code would be showing something the application never runs. One published
   * into a single file has no dll at all, and the executable itself is the output - the viewer then
   * reads the bundle inside it.
   */
  private async findOutputs(projectDirectory: string, projectFile: string, assemblyName: string, limit: number): Promise<ProjectAssembly[]> {
    const find = (pattern: string) =>
      vscode.workspace.findFiles(new vscode.RelativePattern(projectDirectory, pattern), '**/ref/**');

    const assemblies = await find(`bin/**/${assemblyName}.dll`);
    const executable = await find(`bin/**/${assemblyName}`);

    let matches: vscode.Uri[];
    if (await this.readPublishAot(projectFile)) {
      matches = executable.length > 0 ? executable : assemblies;
    } else {
      matches = assemblies.length > 0 ? assemblies : executable;
    }

    const described: ProjectAssembly[] = [];
    for (const match of matches) {
      try {
        const stat = await fs.promises.stat(match.fsPath);
        described.push({
          projectPath: path.join(projectDirectory, `${assemblyName}.${PROJECT_FILES[0]}`),
          projectName: assemblyName,
          assemblyPath: match.fsPath,
          lastWrite: stat.mtimeMs,
        });
      } catch {
        // The output disappeared between discovery and stat; ignore it.
      }
    }

    return described
      .sort((left, right) => right.lastWrite - left.lastWrite)
      .slice(0, Math.max(limit, 1));
  }
}

function isInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
