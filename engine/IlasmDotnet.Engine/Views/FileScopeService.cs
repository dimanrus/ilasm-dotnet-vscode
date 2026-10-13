using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>
/// Answers "what is in this source file" and produces whole-file views.
///
/// The source file, not the type, is the unit a developer has open, and one file can hold several
/// types (a record next to the class that uses it, for example). The member list comes from the
/// portable PDB, so it reflects the bodies actually written in that file.
/// </summary>
public static class FileScopeService
{
    public static FileScopeDto Describe(AssemblyEntry entry, SourceIndex index, string file, bool includeGenerated)
    {
        var members = Members(index, file, includeGenerated);

        var types = new List<TypeDto>();
        foreach (var token in members.Select(member => member.TypeToken).Distinct())
        {
            var handle = MetadataTokens.TypeDefinitionHandle(token);
            if (!handle.IsNil)
            {
                types.Add(entry.DescribeType(handle));
            }
        }

        return new FileScopeDto(file, types, members);
    }

    /// <summary>Members of the file, optionally including compiler generated ones.</summary>
    public static IReadOnlyList<MemberLocationDto> Members(SourceIndex index, string file, bool includeGenerated)
    {
        var members = index.MembersForFile(file);
        if (includeGenerated)
        {
            return members;
        }

        return members.Where(member => !IsGenerated(member.Name) && !IsGenerated(member.DeclaringType)).ToList();
    }

    /// <summary>Distinct types that declare any member present in the file.</summary>
    public static IReadOnlyList<int> TypeTokens(SourceIndex index, string file, bool includeGenerated) =>
        Members(index, file, includeGenerated)
            .Select(member => member.TypeToken)
            .Distinct()
            .ToList();

    /// <summary>Method tokens of the bodies written in the file, which is the scope of its ASM.</summary>
    public static IReadOnlyList<MethodDefinitionHandle> MethodHandles(SourceIndex index, string file, bool includeGenerated) =>
        Members(index, file, includeGenerated)
            .Select(member => MetadataTokens.MethodDefinitionHandle(member.Token))
            .Where(handle => !handle.IsNil)
            .ToList();

    public static ViewDto BuildIl(AssemblyEntry entry, IReadOnlyList<int> typeTokens, string file, bool generatedOnly)
    {
        var parts = new List<ViewDto>();
        foreach (var token in WithoutNestedTypes(entry, typeTokens))
        {
            parts.Add(IlViewService.Build(entry, HandleOf(token), DescribeToken(entry, token)));
        }

        return Compose(entry, parts, file, "il", lowLevel: false, generatedOnly);
    }

    public static ViewDto BuildCSharp(
        AssemblyEntry entry,
        IReadOnlyList<int> typeTokens,
        string file,
        bool includeGenerated,
        bool lowLevel,
        bool generatedOnly)
    {
        var parts = new List<ViewDto>();
        foreach (var token in WithoutNestedTypes(entry, typeTokens))
        {
            parts.Add(CSharpViewService.Build(entry, HandleOf(token), DescribeToken(entry, token), includeGenerated, lowLevel));
        }

        return Compose(entry, parts, file, "csharp", lowLevel, generatedOnly);
    }

    /// <summary>Explains a listing that only exists because the file's own bodies are generated.</summary>
    private static ViewDto GeneratedHeader(string file, string language)
    {
        var prefix = language == "il" ? "; " : "// ";
        return new ViewDto(
            $"header — {file}",
            language,
            prefix
                + "Every body written in this file was moved by the compiler into a type it generated\n"
                + prefix
                + "(the state machine of an async or an iterator method). Those types are listed below so the\n"
                + prefix
                + "code stays readable; set \"ilasmDotnet.includeCompilerGenerated\": true to see them in the\n"
                + prefix
                + "file scope itself.\n",
            false,
            Array.Empty<MapBlock>(),
            new[] { $"{Path.GetFileName(file)} holds nothing but compiler-generated code, shown here as it was emitted." });
    }

    /// <summary>
    /// Whole-file view of one flavour, or the reason there is nothing to show. An empty text is not an
    /// answer a reader can act on: a file whose every body the compiler moved into generated types
    /// looks empty although the code is right there, and a file of a build without a PDB as well.
    /// </summary>
    private static ViewDto Compose(
        AssemblyEntry entry,
        IReadOnlyList<ViewDto> parts,
        string file,
        string language,
        bool lowLevel,
        bool generatedOnly)
    {
        var fileName = Path.GetFileName(file);
        var title = language == "il" ? $"{fileName} — IL" : $"{fileName} — C#{(lowLevel ? " (low level)" : string.Empty)}";

        if (parts.Count == 0)
        {
            return new ViewDto(
                title,
                language,
                $"; Nothing in {fileName} can be shown in this view.\n"
                    + "; The assembly carries no debug information for this file, so no body could be attributed to\n"
                    + "; it. Build the project with a portable PDB to see it here.\n",
                entry.Pdb is not null,
                Array.Empty<MapBlock>(),
                new[] { "No type in this file has debug information." });
        }

        return ViewComposer.Merge(
            title,
            language,
            generatedOnly ? new[] { GeneratedHeader(file, language) }.Concat(parts).ToList() : parts,
            entry.Pdb is not null,
            null);
    }

    /// <summary>
    /// Drops nested types whose declaring type is part of the same list. A view renders a nested type
    /// inside the type that declares it, so keeping both would print it twice — which is what happens
    /// to the generated state machines and display classes of a file as soon as they are included.
    /// </summary>
    private static IReadOnlyList<int> WithoutNestedTypes(AssemblyEntry entry, IReadOnlyList<int> typeTokens)
    {
        var declared = typeTokens.ToHashSet();
        return typeTokens
            .Where(token =>
            {
                var parent = entry.Metadata.GetTypeDefinition(MetadataTokens.TypeDefinitionHandle(token)).GetDeclaringType();
                return parent.IsNil || !declared.Contains(MetadataTokens.GetToken(parent));
            })
            .ToList();
    }

    /// <summary>
    /// Compiler generated members and types carry angle brackets. A generated nested type is named
    /// like <c>SampleLib.Calculator.&lt;Evens&gt;d__5</c>, so it is not enough to look at the start of
    /// the name: a bracket that follows a dot marks it as generated too.
    /// </summary>
    internal static bool IsGenerated(string name) =>
        name.StartsWith('<') ||
        name.Contains(".<", StringComparison.Ordinal) ||
        name.Contains("<>", StringComparison.Ordinal);

    private static EntityHandle HandleOf(int token) => MetadataTokens.EntityHandle(token);

    private static string DescribeToken(AssemblyEntry entry, int token)
    {
        var handle = HandleOf(token);
        return handle.Kind switch
        {
            HandleKind.TypeDefinition => entry.GetFullName((TypeDefinitionHandle)handle),
            HandleKind.MethodDefinition => entry.GetMemberSignature((MethodDefinitionHandle)handle),
            _ => token.ToString(),
        };
    }
}
