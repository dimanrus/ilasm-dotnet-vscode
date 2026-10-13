using System.Reflection.Metadata;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>
/// Maps original source files and lines back to the members that cover them, so the client can
/// resolve "which IL belongs to the line my caret is on" without rebuilding the assembly.
/// </summary>
public sealed class SourceIndex
{
    /// <summary>How far from the requested line a mapped line may be to still count as a match.</summary>
    private const int FallbackWindowLines = 25;

    private readonly List<Entry> _entries = new();

    public SourceIndex(AssemblyEntry assembly)
    {
        foreach (var typeHandle in assembly.EnumerateTypes())
        {
            var type = assembly.Metadata.GetTypeDefinition(typeHandle);
            var declaringType = assembly.GetFullName(typeHandle);

            foreach (var methodHandle in type.GetMethods())
            {
                var method = assembly.Metadata.GetMethodDefinition(methodHandle);
                var token = AssemblyEntry.TokenOf(methodHandle);
                var name = assembly.Metadata.GetString(method.Name);
                var (owner, accessor) = assembly.DescribeAccessor(methodHandle);
                var location = new MemberLocationDto(
                    token,
                    AssemblyEntry.TokenOf(typeHandle),
                    name is ".ctor" or ".cctor" ? "constructor" : "method",
                    name,
                    declaringType,
                    0,
                    owner,
                    accessor);

                var points = assembly.Pdb?.GetSequencePoints(token);
                if (points is null)
                {
                    continue;
                }

                foreach (var point in points)
                {
                    if (string.IsNullOrEmpty(point.DocumentUrl))
                    {
                        continue;
                    }

                    _entries.Add(new Entry(
                        assembly.EnclosingTypes(typeHandle).Select(handle => AssemblyEntry.TokenOf(handle)).ToList(),
                        Normalize(point.DocumentUrl),
                        point.DocumentUrl,
                        point.StartLine,
                        Math.Max(point.StartLine, point.EndLine),
                        location));
                }
            }
        }
    }

    /// <summary>True when the assembly carried a PDB, i.e. source mapping is possible at all.</summary>
    public bool HasEntries => _entries.Count > 0;

    /// <summary>
    /// Where a member, or a type through any of its members, was compiled from: the file and the first
    /// line of that token in it. The tree knows tokens rather than positions, so a click there has to
    /// be turned into a file to show and a line to put the caret on. The path is returned the way the
    /// PDB spells it, which is the form the viewer sends back.
    /// </summary>
    public TokenSource? SourceOf(int token)
    {
        TokenSource? found = null;
        foreach (var entry in _entries)
        {
            if (entry.Member.Token != token && !entry.EnclosingTypes.Contains(token))
            {
                continue;
            }

            if (found is null || entry.StartLine < found.Value.Line)
            {
                found = new TokenSource(entry.Path, entry.StartLine);
            }
        }

        return found;
    }

    /// <summary>
    /// Distinct members that have at least one sequence point in the given file, which is what
    /// "everything declared in this file" means for a whole-file view.
    /// </summary>
    public IReadOnlyList<MemberLocationDto> MembersForFile(string file)
    {
        var normalized = Normalize(file);
        var seen = new HashSet<int>();
        var members = new List<MemberLocationDto>();

        foreach (var entry in _entries)
        {
            if (!string.Equals(entry.File, normalized, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (seen.Add(entry.Member.Token))
            {
                members.Add(entry.Member);
            }
        }

        return members
            .OrderBy(member => member.Kind == "constructor" ? 0 : 1)
            .ThenBy(member => member.Name, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Resolves the member that covers a source line. Optimized builds drop sequence points for
    /// lines the compiler removed, so when the exact line is not mapped the closest mapped line in
    /// the same file is used instead of giving up.
    /// </summary>
    public MemberLocationDto? Find(string file, int line)
    {
        var normalized = Normalize(file);
        Entry? best = null;

        foreach (var entry in _entries)
        {
            if (!string.Equals(entry.File, normalized, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (line < entry.StartLine || line > entry.EndLine)
            {
                continue;
            }

            if (best is null || entry.SpanSize < best.SpanSize)
            {
                best = entry;
            }
        }

        if (best is not null)
        {
            return best.Member;
        }

        Entry? nearest = null;
        var nearestDistance = int.MaxValue;

        foreach (var entry in _entries)
        {
            if (!string.Equals(entry.File, normalized, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var distance = line < entry.StartLine ? entry.StartLine - line : line - entry.EndLine;
            if (distance > FallbackWindowLines)
            {
                continue;
            }

            if (distance < nearestDistance || (distance == nearestDistance && entry.StartLine < (nearest?.StartLine ?? int.MaxValue)))
            {
                nearest = entry;
                nearestDistance = distance;
            }
        }

        return nearest?.Member;
    }

    private static string Normalize(string path) =>
        path.Replace('\\', '/').Trim().ToLowerInvariant();

    /// <summary>File a token was compiled from, and the first of its lines in that file.</summary>
    public readonly record struct TokenSource(string File, int Line);

    private sealed record Entry(
        IReadOnlyList<int> EnclosingTypes,
        string File,
        string Path,
        int StartLine,
        int EndLine,
        MemberLocationDto Member)
    {
        public int SpanSize => EndLine - StartLine;
    }
}
