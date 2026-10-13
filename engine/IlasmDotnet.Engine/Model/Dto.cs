namespace IlasmDotnet.Engine.Model;

/// <summary>Summary information about a single assembly on disk.</summary>
public sealed record AssemblyInfoDto(
    string Path,
    string Name,
    string Version,
    string TargetFramework,
    string Architecture,
    bool IsExecutable,
    bool HasPdb,
    int TypeCount);

public sealed record TypeDto(
    int Token,
    string Name,
    string Namespace,
    string FullName,
    string Kind,
    string Accessibility,
    int MemberCount,
    int NestedTypeCount);

public sealed record MemberDto(
    int Token,
    string Name,
    string Kind,
    string Signature,
    string DeclaringType);

/// <summary>
/// A run of text that shares one anchor. Anchors are IL offsets (for method bodies) and
/// original source positions, which is what lets the client link the IL and C# views.
/// </summary>
public sealed record MapBlock(
    int MethodToken,
    int IlStart,
    int IlEnd,
    int TextStartLine,
    int TextEndLine,
    string? SourceFile,
    int SourceStartLine,
    int SourceEndLine);

public sealed record ViewDto(
    string Title,
    string Language,
    string Text,
    bool HasDebugInfo,
    IReadOnlyList<MapBlock> Blocks,
    IReadOnlyList<string>? Notes = null);

public sealed record MemberLocationDto(
    int Token,
    int TypeToken,
    string Kind,
    string Name,
    string DeclaringType,
    int SourceLine,
    string? Owner = null,
    string? Accessor = null);

/// <summary>
/// Source of a metadata token: the file it was compiled from and the first line of it there, or
/// nothing when the PDB does not say.
/// </summary>
public sealed record FileOfDto(string? File, int Line);

/// <summary>
/// What a native image is: a NativeAOT binary or an ordinary native library, with the machine it was
/// built for and whether the debug information that ties its code to source lines was found.
/// </summary>
public sealed record NativeInfoDto(
    string Path,
    string Name,
    string Machine,
    bool HasDebugInfo,
    string? DebugFile,
    int MethodCount,
    int RuntimeMethodCount,
    string? Note);

/// <summary>One method of a native image: the code it owns, and where its source line is.</summary>
public sealed record NativeMethodDto(
    int Address,
    int Size,
    string Name,
    string FullName,
    string DeclaringType,
    string File,
    int Line,
    string Symbol,
    bool IsRuntime);

/// <summary>What a source file contains: the types declared in it and the bodies written in it.</summary>
public sealed record FileScopeDto(
    string File,
    IReadOnlyList<TypeDto> Types,
    IReadOnlyList<MemberLocationDto> Members);
