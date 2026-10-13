namespace IlasmDotnet.Engine.Native;

/// <summary>A method as the debug information of a native image describes it.</summary>
public sealed record DwarfMethod(string Name, string LinkageName, string DeclaringType, int DeclarationFile, int DeclarationLine);

/// <summary>
/// The names inside a native image. A symbol of a native image is mangled - the compiler turns every
/// dot into an underscore and joins the type to the method with two - and the mangling cannot be
/// undone by itself: `AotTarget_Target` is a type named Target in a namespace AotTarget, but it could
/// just as well be a type whose own name holds an underscore. The debug information does not have
/// that problem: it keeps the plain name of every method, and the mangled one beside it as the link
/// between a name and a symbol. Reading those pairs is what this does.
/// </summary>
public sealed class DwarfNames
{
    private const int TagSubprogram = 0x2e;
    private const int TagClassType = 0x02;
    private const int TagStructureType = 0x13;
    private const int TagInterfaceType = 0x38;
    private const int TagNamespace = 0x39;

    private const int AttributeName = 0x03;
    private const int AttributeDeclFile = 0x3a;
    private const int AttributeDeclLine = 0x3b;
    private const int AttributeLinkageName = 0x6e;
    private const int AttributeMipsLinkageName = 0x2007;

    private readonly Dictionary<string, DwarfMethod> _byLinkageName = new(StringComparer.Ordinal);

    private DwarfNames()
    {
    }

    /// <summary>Why no names could be read, when that is the case.</summary>
    public string? Note { get; private set; }

    public int Count => _byLinkageName.Count;

    /// <summary>The method the debug information knows under a symbol name.</summary>
    public DwarfMethod? Find(string linkageName) => _byLinkageName.GetValueOrDefault(linkageName);

    public static DwarfNames Load(ElfImage image)
    {
        var names = new DwarfNames();

        byte[]? info;
        byte[]? abbreviations;
        try
        {
            info = image.Data(".debug_info");
            abbreviations = image.Data(".debug_abbrev");
        }
        catch (Exception)
        {
            names.Note = "the debug information of the image could not be read";
            return names;
        }

        var strings = image.Data(".debug_str");
        if (info is null || abbreviations is null || strings is null)
        {
            names.Note = "the image carries no debug information with names";
            return names;
        }

        try
        {
            names.ReadUnits(image, info, abbreviations, strings);
        }
        catch (Exception)
        {
            // Whatever was read before the trouble stays usable, and the reason is reported.
            names.Note ??= "part of the debug information could not be read";
        }

        if (names._byLinkageName.Count == 0)
        {
            names.Note ??= "the debug information names no method";
        }

        return names;
    }

    private void ReadUnits(ElfImage image, byte[] info, byte[] abbreviations, byte[] strings)
    {
        var littleEndian = image.IsLittleEndian;
        var offset = 0L;

        while (offset + 11 <= info.Length)
        {
            var unitLength = ElfImage.ReadUInt32(info, offset, littleEndian);
            if (unitLength == 0xffffffff || unitLength == 0 || offset + 4 + unitLength > info.Length)
            {
                break;
            }

            var version = ElfImage.ReadUInt16(info, offset + 4, littleEndian);
            if (version < 2 || version > 4)
            {
                // A unit of a version this reader does not know cannot be walked, because the header
                // and the forms of its attributes differ; the others are still read.
                Note ??= $"the debug information is of DWARF version {version}, which this route does not read";
                offset += 4 + unitLength;
                continue;
            }

            var abbrevOffset = ElfImage.ReadUInt32(info, offset + 6, littleEndian);

            // The header is the unit length, the version, the offset of the abbreviations and the
            // size of an address; the entries start right after those eleven bytes.
            var at = offset + 11;

            var table = ReadAbbreviations(abbreviations, abbrevOffset, littleEndian);
            var end = offset + 4 + unitLength;
            ReadDies(image, info, strings, at, end, table);
            offset = end;
        }
    }

    private static Dictionary<int, Abbreviation> ReadAbbreviations(byte[] section, long offset, bool littleEndian)
    {
        var result = new Dictionary<int, Abbreviation>();
        var at = offset;

        while (at < section.Length)
        {
            var code = (int)ReadUnsigned(section, ref at);
            if (code == 0)
            {
                break;
            }

            var tag = (int)ReadUnsigned(section, ref at);
            var hasChildren = section[at++] != 0;
            var attributes = new List<AttributeSpec>();

            while (at < section.Length)
            {
                var attribute = (int)ReadUnsigned(section, ref at);
                var form = (int)ReadUnsigned(section, ref at);
                if (attribute == 0 && form == 0)
                {
                    break;
                }

                var implicitValue = 0;
                if (form == 0x21)
                {
                    implicitValue = (int)ReadSigned(section, ref at);
                }

                attributes.Add(new AttributeSpec(attribute, form, implicitValue));
            }

            result[code] = new Abbreviation(tag, hasChildren, attributes);
        }

        return result;
    }

    private void ReadDies(
        ElfImage image,
        byte[] info,
        byte[] strings,
        long start,
        long end,
        Dictionary<int, Abbreviation> table)
    {
        var stack = new List<string>();
        var at = start;

        while (at < end && at < info.Length)
        {
            var code = (int)ReadUnsigned(info, ref at);
            if (code == 0)
            {
                if (stack.Count > 0)
                {
                    stack.RemoveAt(stack.Count - 1);
                }

                continue;
            }

            if (!table.TryGetValue(code, out var abbreviation))
            {
                // An unknown abbreviation means the rest of the unit cannot be walked, because its
                // length is unknown.
                return;
            }

            var name = string.Empty;
            var linkageName = string.Empty;
            var declarationFile = 0;
            var declarationLine = 0;

            foreach (var attribute in abbreviation.Attributes)
            {
                var value = ReadValue(info, ref at, attribute, image, strings);
                switch (attribute.Attribute)
                {
                    case AttributeName:
                        name = value.Text;
                        break;

                    case AttributeLinkageName:
                    case AttributeMipsLinkageName:
                        linkageName = value.Text;
                        break;

                    case AttributeDeclFile:
                        declarationFile = (int)value.Number;
                        break;

                    case AttributeDeclLine:
                        declarationLine = (int)value.Number;
                        break;
                }
            }

            if (abbreviation.Tag == TagSubprogram && linkageName.Length > 0 && name.Length > 0)
            {
                var declaringType = stack.Count > 0 ? stack[^1] : string.Empty;
                _byLinkageName.TryAdd(linkageName, new DwarfMethod(name, linkageName, declaringType, declarationFile, declarationLine));
            }

            if (!abbreviation.HasChildren)
            {
                continue;
            }

            var container = abbreviation.Tag switch
            {
                TagClassType or TagStructureType or TagInterfaceType or TagNamespace => name,
                _ => string.Empty,
            };

            stack.Add(container);
        }
    }

    /// <summary>
    /// The value of one attribute, as text and as a number. Only the forms the names of methods are
    /// written with are understood; the rest are stepped over so that the walk stays aligned.
    /// </summary>
    private static (string Text, long Number) ReadValue(byte[] info, ref long at, AttributeSpec attribute, ElfImage image, byte[] strings)
    {
        switch (attribute.Form)
        {
            case 0x08: // string
                var text = ElfImage.ReadString(info, at);
                at += text.Length + 1;
                return (text, 0);

            case 0x0e: // strp
                var offset = (long)ElfImage.ReadUInt32(info, at, image.IsLittleEndian);
                at += 4;
                return (ElfImage.ReadString(strings, offset), 0);

            case 0x0f: // udata
                return (string.Empty, (long)ReadUnsigned(info, ref at));

            case 0x0d: // sdata
                return (string.Empty, ReadSigned(info, ref at));

            case 0x0b: // data1
            case 0x0c: // flag
                return (string.Empty, info[at++]);

            case 0x05: // data2
                var two = (long)ElfImage.ReadUInt16(info, at, image.IsLittleEndian);
                at += 2;
                return (string.Empty, two);

            case 0x06: // data4
                var four = (long)ElfImage.ReadUInt32(info, at, image.IsLittleEndian);
                at += 4;
                return (string.Empty, four);

            case 0x07: // data8
                var eight = (long)ElfImage.ReadUInt64(info, at, image.IsLittleEndian);
                at += 8;
                return (string.Empty, eight);

            case 0x21: // implicit_const, whose value lives in the abbreviation
                return (string.Empty, attribute.ImplicitValue);

            case 0x19: // flag_present
                return (string.Empty, 1);

            case 0x01: // addr
                at += 8;
                return (string.Empty, 0);

            case 0x17: // sec_offset
                at += 4;
                return (string.Empty, 0);

            case 0x10: // ref_addr
                at += 4;
                return (string.Empty, 0);

            case 0x11: // ref1
                at += 1;
                return (string.Empty, 0);

            case 0x12: // ref2
                at += 2;
                return (string.Empty, 0);

            case 0x13: // ref4
            case 0x1c: // ref_sup4
                at += 4;
                return (string.Empty, 0);

            case 0x14: // ref8
            case 0x20: // ref_sig8
                at += 8;
                return (string.Empty, 0);

            case 0x15: // ref_udata
                ReadUnsigned(info, ref at);
                return (string.Empty, 0);

            case 0x18: // exprloc
            case 0x0a: // block
                at += (long)ReadUnsigned(info, ref at);
                return (string.Empty, 0);

            case 0x09: // block1
                at += 1 + info[at];
                return (string.Empty, 0);

            case 0x03: // block2
                at += 2 + ElfImage.ReadUInt16(info, at, image.IsLittleEndian);
                return (string.Empty, 0);

            case 0x04: // block4
                at += 4 + (long)ElfImage.ReadUInt32(info, at, image.IsLittleEndian);
                return (string.Empty, 0);

            default:
                throw new NotSupportedException($"a DWARF form (0x{attribute.Form:x}) this route does not read");
        }
    }

    private static ulong ReadUnsigned(byte[] section, ref long at)
    {
        ulong result = 0;
        var shift = 0;
        while (at < section.Length && shift < 64)
        {
            var value = section[at++];
            result |= (ulong)(value & 0x7f) << shift;
            if ((value & 0x80) == 0)
            {
                break;
            }

            shift += 7;
        }

        return result;
    }

    private static int ReadSigned(byte[] section, ref long at)
    {
        long result = 0;
        var shift = 0;
        byte value = 0;
        while (at < section.Length && shift < 64)
        {
            value = section[at++];
            result |= (long)(value & 0x7f) << shift;
            shift += 7;
            if ((value & 0x80) == 0)
            {
                break;
            }
        }

        if (shift < 64 && (value & 0x40) != 0)
        {
            result |= -1L << shift;
        }

        return (int)result;
    }

    private readonly record struct AttributeSpec(int Attribute, int Form, int ImplicitValue);

    private readonly record struct Abbreviation(int Tag, bool HasChildren, List<AttributeSpec> Attributes);
}
