using System.Reflection.Metadata;
using System.Text;
using ICSharpCode.Decompiler.CSharp;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>
/// Produces the decompiled C# view. The text is assembled member by member, which keeps an exact
/// line range for every member so the client can link a C# line to the IL of the member it belongs to.
///
/// It comes in two flavours, the same two the ILASM Dotnet of Rider offers: the high-level one shows the
/// code the way a person would write it, the low-level one shows what the compiler made of it —
/// anonymous methods instead of lambdas, loops over enumerators instead of foreach, state machines
/// instead of await and yield, and the generated types and members that go with them.
/// </summary>
public static class CSharpViewService
{
    public static ViewDto Build(AssemblyEntry entry, EntityHandle handle, string title, bool includeCompilerGenerated, bool lowLevel = false)
    {
        var writer = new LineWriter();
        var blocks = new List<MapBlock>();
        var decompile = DecompilerFor(entry, lowLevel);
        // The generated types and members are the interesting part of a low-level view, so they are
        // always shown there whatever the setting says.
        includeCompilerGenerated |= lowLevel;

        if (handle.Kind == HandleKind.TypeDefinition)
        {
            var typeHandle = (TypeDefinitionHandle)handle;
            var usingDirectives = new HashSet<string>(StringComparer.Ordinal);
            WriteTypeHeader(writer, entry, typeHandle);
            WriteMembers(writer, blocks, entry, typeHandle, depth: 1, includeCompilerGenerated, usingDirectives, decompile);
            writer.AppendLine("}");

            if (usingDirectives.Count > 0)
            {
                var header = new LineWriter();
                foreach (var directive in usingDirectives.OrderBy(static d => d, StringComparer.Ordinal))
                {
                    header.AppendLine(directive);
                }

                header.AppendLine();
                return new ViewDto(title, "csharp", header.Text + writer.Text, entry.Pdb is not null, OffsetBlocks(blocks, header.Line - 1));
            }
        }
        else
        {
            WriteMember(writer, blocks, entry, handle, indent: string.Empty, usingDirectives: null, decompile);
        }

        return new ViewDto(title, "csharp", writer.Text, entry.Pdb is not null, blocks);
    }

    /// <summary>Decompiler the view is rendered with: the sugar one, or the one that keeps the lowering.</summary>
    public static CSharpDecompiler DecompilerFor(AssemblyEntry entry, bool lowLevel) =>
        lowLevel ? entry.DecompilerLowLevel : entry.Decompiler;

    private static IReadOnlyList<MapBlock> OffsetBlocks(IReadOnlyList<MapBlock> blocks, int lineOffset) =>
        lineOffset == 0
            ? blocks
            : blocks
                .Select(b => b with
                {
                    TextStartLine = b.TextStartLine + lineOffset,
                    TextEndLine = b.TextEndLine + lineOffset,
                })
                .ToList();

    private static void WriteMembers(
        LineWriter writer,
        List<MapBlock> blocks,
        AssemblyEntry entry,
        TypeDefinitionHandle typeHandle,
        int depth,
        bool includeCompilerGenerated,
        HashSet<string> usingDirectives,
        CSharpDecompiler decompile)
    {
        var indent = new string(' ', depth * 4);

        foreach (var member in entry.EnumerateMembers(typeHandle, includeCompilerGenerated))
        {
            // An accessor is not a member C# can express on its own: the property or event it
            // belongs to is listed right beside it, so only that one is rendered.
            if (IsRenderedElsewhere(entry, member, includeCompilerGenerated))
            {
                continue;
            }

            if (member.Kind == "nestedtype")
            {
                writer.AppendLine();
                writer.AppendLine($"{indent}// nested type: {entry.GetFullName((TypeDefinitionHandle)member.Handle)}");
                WriteTypeHeader(writer, entry, (TypeDefinitionHandle)member.Handle, indent);
                WriteMembers(writer, blocks, entry, (TypeDefinitionHandle)member.Handle, depth + 1, includeCompilerGenerated, usingDirectives, decompile);
                writer.AppendLine($"{indent}}}");
                continue;
            }

            WriteMember(writer, blocks, entry, member.Handle, indent, usingDirectives, decompile);
        }
    }

    /// <summary>
    /// True for members the C# view renders as part of another one: an accessor whose property or
    /// event is listed as well. An accessor of a hidden member keeps its own entry, so nothing
    /// disappears together with the view it would have been folded into.
    /// </summary>
    private static bool IsRenderedElsewhere(AssemblyEntry entry, MemberRef member, bool includeCompilerGenerated)
    {
        if (member.Kind != "method")
        {
            return false;
        }

        var owner = entry.FindAccessorOwner(member.Handle);
        if (owner.IsNil)
        {
            return false;
        }

        var name = entry.GetPropertyOrEventName(owner);
        return includeCompilerGenerated || !name.StartsWith('<');
    }

    private static void WriteMember(
        LineWriter writer,
        List<MapBlock> blocks,
        AssemblyEntry entry,
        EntityHandle handle,
        string indent,
        HashSet<string>? usingDirectives,
        CSharpDecompiler decompile)
    {
        // The scope can name an accessor, which is a method. Its C# is the property or event it
        // belongs to, while the blocks keep the accessor token so the other panes still link to it.
        var owner = entry.FindAccessorOwner(handle);
        var target = owner.IsNil ? handle : owner;

        writer.AppendLine();
        writer.AppendLine($"{indent}// ── {entry.GetMemberSignature(handle)}");
        if (!owner.IsNil)
        {
            writer.AppendLine($"{indent}// shown as {entry.GetMemberSignature(owner)}, which this accessor belongs to");
        }

        var lines = SplitLines(TryDecompile(decompile, target)).ToList();
        if (usingDirectives is not null)
        {
            // The decompiler repeats the required using directives for every member; hoist them
            // to the top of the document so the text stays readable.
            var index = 0;
            while (index < lines.Count && (lines[index].StartsWith("using ", StringComparison.Ordinal) || lines[index].Length == 0))
            {
                if (lines[index].Length > 0)
                {
                    usingDirectives.Add(lines[index]);
                }

                index++;
            }

            lines = lines.Skip(index).ToList();
        }

        var startLine = writer.Line;
        foreach (var line in lines)
        {
            writer.AppendLine(line.Length == 0 ? string.Empty : indent + line);
        }

        var endLine = Math.Max(startLine, writer.Line - 1);
        foreach (var accessor in entry.GetAccessors(handle))
        {
            var token = AssemblyEntry.TokenOf(accessor);
            var span = entry.GetSourceSpan(token);
            blocks.Add(new MapBlock(
                token,
                0,
                entry.GetMethodBodySize(token),
                startLine,
                endLine,
                span.File,
                span.StartLine,
                span.EndLine));
        }
    }

    private static string TryDecompile(CSharpDecompiler decompiler, EntityHandle handle)
    {
        try
        {
            return decompiler.Decompile(new[] { handle }).ToString().TrimEnd('\r', '\n');
        }
        catch (Exception ex)
        {
            return $"// decompilation failed: {ex.Message}";
        }
    }

    private static IEnumerable<string> SplitLines(string text) =>
        text.Replace("\r\n", "\n").Split('\n');

    private static void WriteTypeHeader(LineWriter writer, AssemblyEntry entry, TypeDefinitionHandle handle, string indent = "")
    {
        var descriptor = entry.DescribeType(handle);
        var keyword = descriptor.Kind switch
        {
            "interface" => "interface",
            "struct" => "struct",
            "enum" => "enum",
            "delegate" => "delegate",
            _ => "class",
        };

        writer.AppendLine();
        writer.AppendLine($"{indent}// assembly type: {descriptor.FullName}");
        writer.AppendLine($"{indent}{descriptor.Accessibility} {keyword} {descriptor.Name.Split('.').Last()}");
        writer.AppendLine($"{indent}{{");
    }

    /// <summary>Assigns 1-based line numbers to the text as it is appended.</summary>
    private sealed class LineWriter
    {
        private readonly StringBuilder _builder = new();

        public int Line { get; private set; } = 1;

        public string Text => _builder.ToString();

        public void AppendLine(string text = "")
        {
            _builder.Append(text);
            _builder.Append('\n');
            Line++;
        }
    }
}
