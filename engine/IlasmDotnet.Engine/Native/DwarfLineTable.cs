namespace IlasmDotnet.Engine.Native;

/// <summary>One row of a line table: an address of machine code and the source position it came from.</summary>
public sealed record LineRow(ulong Address, int File, int Line, bool EndOfSequence);

/// <summary>
/// The line table of a native image: the addresses of the machine code together with the line of
/// source each of them was compiled from. It does here what a portable PDB does for a managed
/// assembly, and it is what lets a native listing follow the caret in a .cs file even though there is
/// no IL to point at.
///
/// The compiler writes the table as a small program that moves a cursor over addresses and lines, so
/// running it is the only way to get the mapping out. The header in front of that program differs
/// between versions of DWARF, and one image mixes them: the runtime comes from object files of one
/// version, the code generated from IL from another.
/// </summary>
public sealed class DwarfLineTable
{
    private const byte OpcodeExtended = 0;
    private const byte OpcodeCopy = 1;
    private const byte OpcodeAdvancePc = 2;
    private const byte OpcodeAdvanceLine = 3;
    private const byte OpcodeSetFile = 4;
    private const byte OpcodeSetColumn = 5;
    private const byte OpcodeConstAddPc = 8;
    private const byte OpcodeFixedAdvancePc = 9;
    private const byte ExtendedEndSequence = 1;
    private const byte ExtendedSetAddress = 2;
    private const byte ExtendedDefineFile = 3;

    private const int FormAddress = 0x01;
    private const int FormData2 = 0x05;
    private const int FormData4 = 0x06;
    private const int FormData8 = 0x07;
    private const int FormString = 0x08;
    private const int FormData1 = 0x0b;
    private const int FormFlag = 0x0c;
    private const int FormSdata = 0x0d;
    private const int FormStrp = 0x0e;
    private const int FormUdata = 0x0f;
    private const int FormRefAddr = 0x10;
    private const int FormRef1 = 0x11;
    private const int FormRef2 = 0x12;
    private const int FormRef4 = 0x13;
    private const int FormRef8 = 0x14;
    private const int FormRefUdata = 0x15;
    private const int FormIndirect = 0x16;
    private const int FormSecOffset = 0x17;
    private const int FormExprloc = 0x18;
    private const int FormFlagPresent = 0x19;
    private const int FormStrx = 0x1a;
    private const int FormAddrx = 0x1b;
    private const int FormRefSup4 = 0x1c;
    private const int FormData16 = 0x1e;
    private const int FormLineStrp = 0x1f;
    private const int FormRefSig8 = 0x20;
    private const int FormImplicitConst = 0x21;
    private const int FormLoclistx = 0x22;
    private const int FormRnglistx = 0x23;
    private const int FormStrx1 = 0x25;
    private const int FormStrx2 = 0x26;
    private const int FormStrx3 = 0x27;
    private const int FormStrx4 = 0x28;
    private const int FormAddrx1 = 0x29;
    private const int FormAddrx2 = 0x2a;
    private const int FormAddrx3 = 0x2b;
    private const int FormAddrx4 = 0x2c;

    private readonly List<LineRow> _rows = [];
    private readonly List<string> _files = [string.Empty];

    private DwarfLineTable()
    {
    }

    /// <summary>Why no line information could be read, when that is the case.</summary>
    public string? Note { get; private set; }

    /// <summary>The rows of every unit of the section, ordered by address.</summary>
    public IReadOnlyList<LineRow> Rows => _rows;

    public string? FileOf(int index) => index >= 0 && index < _files.Count ? _files[index] : null;

    /// <summary>Reads the line table of an image that carries debug information.</summary>
    public static DwarfLineTable Load(ElfImage image)
    {
        var table = new DwarfLineTable();
        var section = image.Data(".debug_line");
        if (section is null || section.Length == 0)
        {
            table.Note = "the image carries no line table";
            return table;
        }

        var directories = image.Data(".debug_line_str");
        var strings = image.Data(".debug_str");
        var offset = 0L;

        while (offset + 4 <= section.Length)
        {
            var unitLength = ElfImage.ReadUInt32(section, offset, image.IsLittleEndian);
            if (unitLength == 0xffffffff)
            {
                // 64-bit DWARF would need 64-bit offsets throughout; no .NET image writes one, so it
                // is reported rather than guessed at.
                table.Note = "the line table uses 64-bit DWARF offsets, which this route does not read";
                return table;
            }

            if (unitLength == 0 || offset + 4 + unitLength > section.Length)
            {
                break;
            }

            try
            {
                table.ReadUnit(image, section, offset, unitLength, directories, strings);
            }
            catch (Exception)
            {
                // A unit that cannot be read must not cost the others, and the reason is worth saying.
                table.Note ??= "part of the line table could not be read";
            }

            offset += 4 + unitLength;
        }

        table._rows.Sort((left, right) => left.Address.CompareTo(right.Address));
        if (table._rows.Count == 0)
        {
            table.Note ??= "the line table holds no rows";
        }

        return table;
    }

    /// <summary>The row that describes the code at an address: the last one starting at or before it.</summary>
    public LineRow? At(ulong address)
    {
        var low = 0;
        var high = _rows.Count - 1;
        LineRow? best = null;

        while (low <= high)
        {
            var middle = (low + high) / 2;
            var row = _rows[middle];
            if (row.Address <= address)
            {
                if (!row.EndOfSequence)
                {
                    best = row;
                }

                low = middle + 1;
            }
            else
            {
                high = middle - 1;
            }
        }

        return best;
    }

    /// <summary>
    /// The first address that belongs to a line of a file. A line without an address of its own - a
    /// closing brace, a line the compiler folded away - is matched to the nearest line that has one,
    /// the same way the managed route handles the sparse sequence points of a release build.
    /// </summary>
    public ulong? AddressOf(string file, int line, int window = 25)
    {
        ulong? exact = null;
        ulong? neighbour = null;
        var neighbourDistance = int.MaxValue;

        foreach (var row in _rows)
        {
            if (row.EndOfSequence || row.Line <= 0 || FileOf(row.File) is not { } rowFile || !SameFile(rowFile, file))
            {
                continue;
            }

            if (row.Line == line)
            {
                exact = exact is null || row.Address < exact ? row.Address : exact;
                continue;
            }

            var distance = Math.Abs(row.Line - line);
            if (distance <= window && distance < neighbourDistance)
            {
                neighbourDistance = distance;
                neighbour = row.Address;
            }
        }

        return exact ?? neighbour;
    }

    private static bool SameFile(string left, string right) =>
        string.Equals(left.Replace('\\', '/'), right.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase);

    private void ReadUnit(ElfImage image, byte[] section, long unitStart, uint unitLength, byte[]? directories, byte[]? strings)
    {
        var littleEndian = image.IsLittleEndian;
        var version = ElfImage.ReadUInt16(section, unitStart + 4, littleEndian);
        if (version < 2 || version > 5)
        {
            Note ??= $"the line table is of DWARF version {version}, which this route does not read";
            return;
        }

        var header = unitStart + 6L;
        var addressSize = image.Is64Bit ? 8 : 4;
        if (version >= 5)
        {
            addressSize = section[header++];
            header++; // segment selector size, always zero
        }

        var headerLength = ElfImage.ReadUInt32(section, header, littleEndian);
        var at = header + 4;

        var minimumInstructionLength = section[at++];
        if (version >= 4)
        {
            at++; // maximum_operations_per_instruction, one for every image this route reads
        }

        at++; // default_is_stmt
        var lineBase = (sbyte)section[at++];
        var lineRange = section[at++];
        var opcodeBase = section[at++];

        if (lineRange == 0 || opcodeBase == 0 || minimumInstructionLength == 0)
        {
            Note ??= "the line table has an unusable header";
            return;
        }

        var standardOpcodeLengths = new int[opcodeBase];
        for (var opcode = 1; opcode < opcodeBase; opcode++)
        {
            standardOpcodeLengths[opcode] = section[at++];
        }

        var unitDirectories = version >= 5
            ? ReadDirectoriesV5(section, ref at, directories, strings)
            : ReadDirectories(section, ref at);

        var unitFiles = version >= 5
            ? ReadFilesV5(section, ref at, directories, strings, unitDirectories)
            : ReadFiles(section, ref at, unitDirectories);

        var program = header + 4 + headerLength;
        var end = unitStart + 4 + unitLength;
        ReadProgram(image, section, program, end, minimumInstructionLength, lineBase, lineRange, opcodeBase, standardOpcodeLengths, unitFiles, addressSize);
    }

    private static List<string> ReadDirectories(byte[] section, ref long at)
    {
        var directories = new List<string> { string.Empty };
        while (at < section.Length && section[at] != 0)
        {
            var directory = ElfImage.ReadString(section, at).Replace('\\', '/');
            directories.Add(directory);
            at += directory.Length + 1;
        }

        at++;
        return directories;
    }

    private static List<string> ReadDirectoriesV5(byte[] section, ref long at, byte[]? lineStrings, byte[]? strings)
    {
        var format = ReadFormat(section, ref at);
        var count = (long)ReadUnsigned(section, ref at);
        var directories = new List<string> { string.Empty };

        for (var index = 0; index < count; index++)
        {
            var path = string.Empty;
            foreach (var (content, form) in format)
            {
                var value = ReadForm(section, ref at, form, lineStrings, strings);
                if (content == DirectoryContentPath)
                {
                    path = value.Replace('\\', '/');
                }
            }

            directories.Add(path);
        }

        return directories;
    }

    private List<int> ReadFiles(byte[] section, ref long at, List<string> directories)
    {
        var files = new List<int> { 0 };
        while (at < section.Length && section[at] != 0)
        {
            var name = ElfImage.ReadString(section, at).Replace('\\', '/');
            at += name.Length + 1;

            var directoryIndex = (int)ReadUnsigned(section, ref at);
            ReadUnsigned(section, ref at); // modification time
            ReadUnsigned(section, ref at); // size
            files.Add(FileIndex(name, directoryIndex, directories));
        }

        at++;
        return files;
    }

    private List<int> ReadFilesV5(byte[] section, ref long at, byte[]? lineStrings, byte[]? strings, List<string> directories)
    {
        var format = ReadFormat(section, ref at);
        var count = (long)ReadUnsigned(section, ref at);
        var files = new List<int> { 0 };

        for (var index = 0; index < count; index++)
        {
            var name = string.Empty;
            var directoryIndex = 0;
            foreach (var (content, form) in format)
            {
                var value = ReadForm(section, ref at, form, lineStrings, strings);
                switch (content)
                {
                    case FileContentPath:
                        name = value.Replace('\\', '/');
                        break;

                    case FileContentDirectory:
                        directoryIndex = int.TryParse(value, out var parsed) ? parsed : 0;
                        break;
                }
            }

            files.Add(FileIndex(name, directoryIndex, directories));
        }

        return files;
    }

    private const int DirectoryContentPath = 1;
    private const int FileContentPath = 1;
    private const int FileContentDirectory = 2;

    /// <summary>Turns a file entry into an index into the file list this table reports.</summary>
    private int FileIndex(string name, int directoryIndex, List<string> directories)
    {
        var path = name;
        if (!Path.IsPathRooted(name) && directoryIndex > 0 && directoryIndex < directories.Count)
        {
            var directory = directories[directoryIndex];
            if (directory.Length > 0)
            {
                path = Path.Combine(directory, name);
            }
        }

        _files.Add(path.Replace('\\', '/'));
        return _files.Count - 1;
    }

    private static List<(int Content, int Form)> ReadFormat(byte[] section, ref long at)
    {
        var count = (long)ReadUnsigned(section, ref at);
        var format = new List<(int, int)>((int)count);
        for (var index = 0; index < count; index++)
        {
            var content = (int)ReadUnsigned(section, ref at);
            var form = (int)ReadUnsigned(section, ref at);
            format.Add((content, form));
        }

        return format;
    }

    /// <summary>Reads one value of the given form, as text, which is all the name tables need.</summary>
    private static string ReadForm(byte[] section, ref long at, int form, byte[]? lineStrings, byte[]? strings)
    {
        switch (form)
        {
            case FormString:
                var text = ElfImage.ReadString(section, at);
                at += text.Length + 1;
                return text;

            case FormStrp:
            case FormLineStrp:
                var offset = (long)ElfImage.ReadUInt32(section, at, true);
                at += 4;
                var table = form == FormLineStrp ? lineStrings : strings;
                return table is null ? string.Empty : ElfImage.ReadString(table, offset);

            case FormData2:
            case FormRef2:
            case FormAddrx2:
            case FormStrx2:
                var two = (long)section[at] | (long)section[at + 1] << 8;
                at += 2;
                return two.ToString();

            case FormData4:
            case FormRef4:
            case FormRefSup4:
            case FormAddrx4:
            case FormStrx4:
                var four = (long)ElfImage.ReadUInt32(section, at, true);
                at += 4;
                return four.ToString();

            case FormData8:
            case FormRef8:
            case FormRefSig8:
                var eight = (long)ElfImage.ReadUInt64(section, at, true);
                at += 8;
                return eight.ToString();

            case FormAddrx3:
            case FormStrx3:
                var three = (long)section[at] | (long)section[at + 1] << 8 | (long)section[at + 2] << 16;
                at += 3;
                return three.ToString();

            case FormUdata:
            case FormStrx:
            case FormAddrx:
            case FormRefUdata:
            case FormLoclistx:
            case FormRnglistx:
                return ReadUnsigned(section, ref at).ToString();

            case FormData1:
            case FormFlag:
            case FormRef1:
            case FormStrx1:
            case FormAddrx1:
            case FormSdata:
                return section[at++].ToString();

            default:
                Skip(section, ref at, form);
                return string.Empty;
        }
    }

    /// <summary>Steps over a value this reader has no use for, so the next one stays aligned.</summary>
    private static void Skip(byte[] section, ref long at, int form)
    {
        switch (form)
        {
            case FormData16:
                at += 16;
                break;

            case FormRefAddr:
                at += 8;
                break;

            case FormSecOffset:
                at += 4;
                break;

            case FormExprloc:
                at += (long)ReadUnsigned(section, ref at);
                break;

            case FormIndirect:
                Skip(section, ref at, (int)ReadUnsigned(section, ref at));
                break;

            case FormFlagPresent:
            case FormImplicitConst:
                break;

            default:
                // A form newer than this reader knows cannot be stepped over blindly, so the unit it
                // belongs to is abandoned rather than read as something it is not.
                throw new NotSupportedException($"a DWARF form (0x{form:x}) this route does not read");
        }
    }

    private void ReadProgram(
        ElfImage image,
        byte[] section,
        long program,
        long end,
        byte minimumInstructionLength,
        sbyte lineBase,
        byte lineRange,
        byte opcodeBase,
        int[] standardOpcodeLengths,
        List<int> files,
        int addressSize)
    {
        ulong address = 0;
        var file = 1;
        var line = 1;
        var at = program;

        while (at < end && at < section.Length)
        {
            var opcode = section[at++];

            if (opcode == OpcodeExtended)
            {
                var length = (long)ReadUnsigned(section, ref at);
                var next = at + length;
                if (length > 0)
                {
                    var extended = section[at++];
                    switch (extended)
                    {
                        case ExtendedEndSequence:
                            Emit(address, file, line, true, files);
                            address = 0;
                            file = 1;
                            line = 1;
                            break;

                        case ExtendedSetAddress:
                            address = ReadAddress(section, at, image.IsLittleEndian, addressSize);
                            break;

                        case ExtendedDefineFile:
                            var name = ElfImage.ReadString(section, at);
                            at += name.Length + 1;
                            var directoryIndex = (int)ReadUnsigned(section, ref at);
                            ReadUnsigned(section, ref at); // modification time
                            ReadUnsigned(section, ref at); // size
                            files.Add(FileIndex(name.Replace('\\', '/'), directoryIndex, []));
                            break;
                    }
                }

                at = next;
                continue;
            }

            if (opcode < opcodeBase)
            {
                switch (opcode)
                {
                    case OpcodeCopy:
                        Emit(address, file, line, false, files);
                        break;

                    case OpcodeAdvancePc:
                        address += (ulong)ReadUnsigned(section, ref at) * minimumInstructionLength;
                        break;

                    case OpcodeAdvanceLine:
                        line += ReadSigned(section, ref at);
                        break;

                    case OpcodeSetFile:
                        file = (int)ReadUnsigned(section, ref at);
                        break;

                    case OpcodeSetColumn:
                        ReadUnsigned(section, ref at);
                        break;

                    case OpcodeConstAddPc:
                        address += (ulong)((255 - opcodeBase) / lineRange) * minimumInstructionLength;
                        break;

                    case OpcodeFixedAdvancePc:
                        address += ElfImage.ReadUInt16(section, at, image.IsLittleEndian);
                        at += 2;
                        break;

                    default:
                        // An opcode this reader does not know still declares how many operands it takes.
                        for (var operand = 0; operand < standardOpcodeLengths[opcode]; operand++)
                        {
                            ReadUnsigned(section, ref at);
                        }

                        break;
                }

                continue;
            }

            var adjusted = opcode - opcodeBase;
            address += (ulong)(adjusted / lineRange) * minimumInstructionLength;
            line += lineBase + adjusted % lineRange;
            Emit(address, file, line, false, files);
        }
    }

    private void Emit(ulong address, int file, int line, bool endOfSequence, List<int> files)
    {
        var mapped = file >= 0 && file < files.Count ? files[file] : 0;
        _rows.Add(new LineRow(address, mapped, line, endOfSequence));
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

    private static ulong ReadAddress(byte[] section, long at, bool littleEndian, int length)
    {
        ulong result = 0;
        for (var index = 0; index < length && at + index < section.Length; index++)
        {
            var value = (ulong)section[(int)at + index];
            result |= littleEndian ? value << (8 * index) : value << (8 * (length - index - 1));
        }

        return result;
    }
}
