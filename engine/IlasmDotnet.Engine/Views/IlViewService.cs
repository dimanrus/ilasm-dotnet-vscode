using System.Globalization;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text.RegularExpressions;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Disassembler;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>
/// Produces an IL listing for a type or member and anchors every instruction line to the
/// IL offset it came from plus the original source line the PDB associates with that offset.
/// </summary>
public static partial class IlViewService
{
    [GeneratedRegex(@"^\s*IL_([0-9a-fA-F]{4}):", RegexOptions.Compiled)]
    private static partial Regex IlLabelRegex();

    [GeneratedRegex(@"/\*\s*([0-9A-Fa-f]{8})\s*\*/", RegexOptions.Compiled)]
    private static partial Regex TokenCommentRegex();

    public static ViewDto Build(AssemblyEntry entry, EntityHandle handle, string title)
    {
        var writer = new StringWriter();
        var output = new PlainTextOutput(writer) { IndentationString = "    " };
        var disassembler = new ReflectionDisassembler(output, CancellationToken.None)
        {
            DetectControlStructure = false,
            ShowSequencePoints = entry.Pdb is not null,
            ShowMetadataTokens = true,
            ShowRawRVAOffsetAndBytes = false,
            DebugInfo = entry.Pdb,
        };

        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
                disassembler.DisassembleType(entry.PE, (TypeDefinitionHandle)handle);
                break;
            case HandleKind.MethodDefinition:
                disassembler.DisassembleMethod(entry.PE, (MethodDefinitionHandle)handle);
                break;
            case HandleKind.FieldDefinition:
                disassembler.DisassembleField(entry.PE, (FieldDefinitionHandle)handle);
                break;
            case HandleKind.PropertyDefinition:
                disassembler.DisassembleProperty(entry.PE, (PropertyDefinitionHandle)handle);
                break;
            case HandleKind.EventDefinition:
                disassembler.DisassembleEvent(entry.PE, (EventDefinitionHandle)handle);
                break;
            default:
                throw new NotSupportedException($"Unsupported metadata handle: {handle.Kind}");
        }

        var text = writer.ToString();
        var methodOrder = handle.Kind == HandleKind.TypeDefinition
            ? entry.GetMethodTokensInDisassemblyOrder((TypeDefinitionHandle)handle)
            : new List<int> { AssemblyEntry.TokenOf(handle) };

        return new ViewDto(title, "il", text, entry.Pdb is not null, BuildBlocks(entry, text, methodOrder));
    }

    private static List<MapBlock> BuildBlocks(AssemblyEntry entry, string text, IReadOnlyList<int> methodOrder)
    {
        var blocks = new List<MapBlock>();
        var lines = text.Split('\n');
        var methodIndex = -1;
        var currentMethod = methodOrder.Count > 0 ? methodOrder[0] : 0;
        var sawToken = false;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i].TrimEnd('\r');
            var trimmed = line.TrimStart();

            if (trimmed.StartsWith(".method", StringComparison.Ordinal))
            {
                // Prefer the metadata token the disassembler prints over positional order,
                // but keep both in sync so nested types stay attributed correctly.
                var tokenMatch = TokenCommentRegex().Match(line);
                if (tokenMatch.Success && TryParseMethodToken(tokenMatch.Groups[1].Value, out var token))
                {
                    currentMethod = token;
                    sawToken = true;
                    for (var index = 0; index < methodOrder.Count; index++)
                    {
                        if (methodOrder[index] == token)
                        {
                            methodIndex = index;
                            break;
                        }
                    }
                }
                else
                {
                    methodIndex = Math.Min(methodIndex + 1, methodOrder.Count - 1);
                    if (!sawToken && methodIndex >= 0)
                    {
                        currentMethod = methodOrder[methodIndex];
                    }
                }

                continue;
            }

            var labelMatch = IlLabelRegex().Match(line);
            if (!labelMatch.Success)
            {
                continue;
            }

            var offset = int.Parse(labelMatch.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            var source = ResolveSource(entry, currentMethod, offset);
            blocks.Add(new MapBlock(
                currentMethod,
                offset,
                offset + 1,
                i + 1,
                i + 1,
                source.File,
                source.StartLine,
                source.EndLine));
        }

        return blocks;
    }

    private static bool TryParseMethodToken(string hex, out int token)
    {
        token = 0;
        if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value))
        {
            return false;
        }

        if ((value & unchecked((int)0xFF000000)) != 0x06000000)
        {
            return false;
        }

        token = value;
        return true;
    }

    internal static (string? File, int StartLine, int EndLine) ResolveSource(AssemblyEntry entry, int methodToken, int ilOffset)
    {
        if (entry.Pdb is null || methodToken == 0)
        {
            return (null, 0, 0);
        }

        var points = entry.Pdb.GetSequencePoints(methodToken);
        var best = (ICSharpCode.Decompiler.DebugInfo.SequencePoint?)null;
        foreach (var point in points)
        {
            if (point.Offset > ilOffset)
            {
                break;
            }

            best = point;
        }

        if (best is null || string.IsNullOrEmpty(best.DocumentUrl))
        {
            return (null, 0, 0);
        }

        var endLine = best.EndLine >= best.StartLine ? best.EndLine : best.StartLine;
        return (best.DocumentUrl, best.StartLine, endLine);
    }
}
