# 📋 Changelog

## [1.0.1] - 2026-10-13

### 🔍 Discovery

- Update keywords
- Add changelog


## [1.0.0] - 2026-10-13 🎉

First public release.

### ✨ Added

**🪟 Views**

- A single viewer tab, reused for every file, view and member: the view switcher (`IL code`,
  `C# (high level)`, `C# (low level)`, `Native ASM`) and the scope switcher (entire file or one member)
  are driven by the CodeLens row above the code and by the status bar.
- IL listing of a whole file, a type or a member: complete `.class`/`.method` output with locals and
  exception handlers.
- Sequence point annotations inside the IL (`// sequence point: (line 18, col 13) …`) with clickable
  links into the source file.
- Decompiled C# in two flavours: high level, as the code was written, and low level, as the compiler
  made it, compiler-generated members included.
- Properties and events shown as properties, with the requested accessor named in the scope list.

**🔗 Mapping**

- Exact IL ↔ source line mapping from the portable PDB, with the PDB identity checked against the
  assembly so that a PDB belonging to another assembly is ignored instead of breaking a view.
- Two-way highlighting and scrolling between the source, the IL pane and the C# pane; a method-level
  link where a view carries no source information.
- Tree nodes resolve through `map/fileOf`, so clicking a type or member opens the source with the caret
  on it and the viewer next to it — including types whose bodies live in generated state machines.

**🔬 Native code**

- JIT listing through the extension's own harness (`DOTNET_JitDisasm` + `RuntimeHelpers.PrepareMethod`),
  optimized (`FullOpts`) or tier 0, without executing the method body.
- Attach to a live .NET process (ClrMD): the exact code the process is running right now, an `IL_xxxx`
  label on every instruction, and a jump from an instruction to its source line.
- ReadyToRun images read without a process, including arm64 images on an x64 machine (Capstone), with
  the instruction → IL map decoded from the `DebugInfo` section. Both the packed (16.0) and the older
  nibble (9.1) encodings are read.
- NativeAOT images: the ELF container, symbols and DWARF give the machine code of a method, its source
  lines, and a mapping that works in both directions.
- Single-file publishes: the bundle is taken apart and every managed view keeps working, compressed
  self-contained bundles included.

**🧰 Tooling**

- ILASM round-trip: the whole listing is written out, assembled back by `ilasm` and compared with the
  original. The assembler ships with the extension for linux-x64/arm64, osx-x64/arm64 and win-x64.
- Side tree of the current file and of the project assemblies with lazy loading, plus
  `ilasmDotnet.assemblies` for assemblies and native images outside the workspace.
- Automatic discovery of the build output for the open source file (`.csproj`, `.fsproj`, `.vbproj`,
  `bin/**`), covering ordinary builds, `PublishAot` and single-file publishes.
- `Show Diagnostics`: versions, paths, settings, PDB state, attach state and what the tab is showing.
- A clear diagnosis instead of `Unknown file format.` for native files (ELF, Mach-O, native PE), and an
  explanatory note when a ReadyToRun image cannot be disassembled.

**🧩 Languages**

- F#, VB and any other .NET language: the viewer reads the assembly, so a `.fs` or `.vb` file opens its
  own IL and links back to the `.fs`/`.vb` source lines.

### 📌 Notes

- Requires VS Code 1.90 or newer and the **.NET 10 runtime**; a newer runtime also works
  (`RollForward=LatestMajor`).
- The extension makes no network requests and collects no telemetry — every view is computed locally by
  the bundled .NET engine.

[1.0.1]: https://github.com/dimanrus/ilasm-dotnet-vscode/releases
[1.0.0]: https://github.com/dimanrus/ilasm-dotnet-vscode/releases
