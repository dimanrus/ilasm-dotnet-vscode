using System.Globalization;
using System.Reflection;
using System.Text.RegularExpressions;

namespace IlasmDotnet.Engine.Metadata;

/// <summary>
/// Spells the implementation attributes of a method the way ILASM accepts them.
///
/// The disassembler of ICSharpCode.Decompiler names the attributes it knows and prints the rest as
/// <c>flags(XXXX)</c> in hexadecimal, while ilasm reads that number as decimal. The .NET 11 runtime
/// added an attribute the disassembler does not know yet — <c>async</c>, which marks a method whose
/// await points the runtime handles itself — so a listing assembled back would silently get other
/// attributes. The bit becomes the keyword ilasm has learned, and any bit the disassembler leaves
/// unnamed stays a number, but decimal.
/// </summary>
public static partial class MethodImplFlags
{
    /// <summary>MethodImplAttributes.Async, introduced in .NET 11 (0x2000).</summary>
    private const int Async = (int)MethodImplAttributes.Async;

    /// <summary>The attributes the disassembler prints as words, with the bits they stand for.</summary>
    private static readonly Dictionary<string, int> Keywords = new(StringComparer.Ordinal)
    {
        ["synchronized"] = 0x0020,
        ["noinlining"] = 0x0008,
        ["nooptimization"] = 0x0040,
        ["preservesig"] = 0x0080,
        ["internalcall"] = 0x1000,
        ["forwardref"] = 0x0010,
        ["aggressiveinlining"] = 0x0100,
        ["aggressiveoptimization"] = 0x0200,
    };

    /// <summary>Every bit that has a keyword, the async one included.</summary>
    private static readonly int NamedBits = Keywords.Values.Aggregate(Async, static (bits, bit) => bits | bit);

    /// <summary>
    /// The attribute list of a method header: everything after <c>cil managed</c> and before the body
    /// opens. Requiring the closing brace or the end of the line keeps the pattern away from string
    /// literals that happen to spell the same words.
    /// </summary>
    [GeneratedRegex(@"(?<impl>\b(?:cil|native|optil|runtime)[ \t]+(?:managed|unmanaged)\b)(?<attrs>[^\r\n{}]*)(?=[ \t]*(?:\{|$))", RegexOptions.Multiline)]
    private static partial Regex MethodAttributesRegex();

    /// <summary>The attributes the disassembler could not name, hexadecimal and four digits wide.</summary>
    [GeneratedRegex(@"^flags\((?<value>[0-9a-fA-F]{4})\)$")]
    private static partial Regex NumericFlagsRegex();

    /// <summary>
    /// Rewrites every method header of the text. A method without an unnamed attribute is left exactly
    /// as it is, so nothing but the runtime async flag changes.
    /// </summary>
    public static string Normalize(string text) =>
        MethodAttributesRegex().Replace(text, static match =>
        {
            var normalized = NormalizeAttributes(match.Groups["impl"].Value, match.Groups["attrs"].Value);
            return normalized is null ? match.Value : match.Groups["impl"].Value + normalized;
        });

    /// <summary>The attribute list with the async bit and unnamed bits spelled the way ilasm reads them.</summary>
    private static string? NormalizeAttributes(string implementation, string attributes)
    {
        var keywords = new List<string>();
        var named = 0;
        var unnamed = 0;

        foreach (var token in attributes.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var numeric = NumericFlagsRegex().Match(token);
            if (numeric.Success)
            {
                unnamed |= int.Parse(numeric.Groups["value"].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                continue;
            }

            if (Keywords.TryGetValue(token, out var bit))
            {
                named |= bit;
            }

            keywords.Add(token);
        }

        if (unnamed == 0)
        {
            return null;
        }

        var total = named | unnamed | CodeTypeOf(implementation);
        if ((total & Async) != 0)
        {
            keywords.Add("async");
        }

        if ((total & ~NamedBits) != 0)
        {
            // ilasm replaces the whole attribute list with a number in parentheses, so the number has
            // to carry the named bits and the kind of code as well.
            keywords.Add($"flags({total.ToString(CultureInfo.InvariantCulture)})");
        }

        var trailingSpace = attributes.EndsWith(' ') ? " " : string.Empty;
        return " " + string.Join(' ', keywords) + trailingSpace;
    }

    /// <summary>The bits of the kind of code and of the managed mask that precede the attribute list.</summary>
    private static int CodeTypeOf(string implementation)
    {
        var bits = 0;
        if (implementation.Contains("native", StringComparison.Ordinal))
        {
            bits = 0x0001;
        }
        else if (implementation.Contains("optil", StringComparison.Ordinal))
        {
            bits = 0x0002;
        }
        else if (implementation.Contains("runtime", StringComparison.Ordinal))
        {
            bits = 0x0003;
        }

        return implementation.Contains("unmanaged", StringComparison.Ordinal) ? bits | 0x0004 : bits;
    }
}
