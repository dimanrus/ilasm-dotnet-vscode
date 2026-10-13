using IlasmDotnet.Engine.Views.ReadyToRun;

namespace IlasmDotnet.Engine.Native;

/// <summary>One section of an ELF file, as the native route needs it.</summary>
public sealed record ElfSection(string Name, uint Type, ulong Flags, ulong Address, ulong Offset, ulong Size);

/// <summary>A symbol of an ELF symbol table: where the code of a method starts and how long it is.</summary>
public sealed record ElfSymbol(string Name, ulong Address, ulong Size, int Type, int SectionIndex)
{
    /// <summary>Whether the symbol describes a function with code of its own.</summary>
    public bool IsFunction => Type == ElfImage.SymbolTypeFunction && Size > 0 && Address != 0;
}

/// <summary>
/// A native image read as an ELF file. A NativeAOT binary has no CLI header and no IL, so nothing that
/// reads managed metadata can open it; what it does have is sections, symbols and, in a debug file
/// beside it, DWARF. This reads exactly those three things: where the code of a method starts and how
/// long it is (symbols), the bytes to disassemble (the section the code lives in) and the debug
/// sections, which hold the line table that ties an address to a line of source.
/// </summary>
public sealed class ElfImage
{
    public const int SymbolTypeFunction = 2;

    private const uint SectionTypeNoBits = 8;
    private const ulong SectionFlagAllocated = 0x2;
    private const ulong SectionFlagExecutable = 0x4;
    private const ulong SectionFlagCompressed = 0x800;
    private const uint CompressionZlib = 1;
    private const int SymbolEntrySize = 24;

    private readonly byte[] _bytes;
    private readonly List<ElfSection> _sections;
    private readonly Dictionary<string, ElfSection> _byName = new(StringComparer.Ordinal);
    private List<ElfSymbol>? _symbols;

    private ElfImage(string path, byte[] bytes, bool is64Bit, bool isLittleEndian, int machine, List<ElfSection> sections)
    {
        Path = path;
        _bytes = bytes;
        Is64Bit = is64Bit;
        IsLittleEndian = isLittleEndian;
        Machine = machine;
        _sections = sections;

        foreach (var section in sections)
        {
            // The first section of a name wins, which is what a reader of `.debug_line` expects.
            _byName.TryAdd(section.Name, section);
        }
    }

    public string Path { get; }

    public bool Is64Bit { get; }

    public bool IsLittleEndian { get; }

    /// <summary>The machine the image was built for, as the ELF header spells it.</summary>
    public int Machine { get; }

    public IReadOnlyList<ElfSection> Sections => _sections;

    public string MachineName => Machine switch
    {
        0x03 => "i386",
        0x28 => "ARM",
        0x3e => "x86-64",
        0xb7 => "AArch64",
        0xf3 => "RISC-V",
        _ => $"0x{Machine:x2}",
    };

    /// <summary>The architecture in the terms the disassembler understands.</summary>
    public ImageArchitecture Architecture => Machine switch
    {
        0x3e => ImageArchitecture.X64,
        0xb7 => ImageArchitecture.Arm64,
        _ => ImageArchitecture.Unknown,
    };

    /// <summary>Whether the bytes start with an ELF header.</summary>
    public static bool LooksLikeElf(ReadOnlySpan<byte> header) =>
        header.Length >= 4 && header[0] == 0x7f && header[1] == (byte)'E' && header[2] == (byte)'L' && header[3] == (byte)'F';

    public static ElfImage Open(string path)
    {
        var bytes = File.ReadAllBytes(path);
        var name = System.IO.Path.GetFileName(path);

        if (!LooksLikeElf(bytes))
        {
            throw new InvalidOperationException($"{name} is not an ELF image.");
        }

        var is64Bit = bytes[4] == 2;
        var isLittleEndian = bytes[5] == 1;
        var machine = ReadUInt16(bytes, 18, isLittleEndian);

        if (!is64Bit)
        {
            throw new InvalidOperationException($"{name} is a 32-bit ELF image, which this route does not read.");
        }

        var sectionOffset = (long)ReadUInt64(bytes, 0x28, isLittleEndian);
        var sectionEntrySize = ReadUInt16(bytes, 0x3a, isLittleEndian);
        var sectionCount = ReadUInt16(bytes, 0x3c, isLittleEndian);
        var namesIndex = ReadUInt16(bytes, 0x3e, isLittleEndian);

        if (sectionOffset <= 0 || sectionCount == 0 || namesIndex >= sectionCount || sectionEntrySize < 64)
        {
            throw new InvalidOperationException(
                $"{name} has no usable section table, so its symbols and debug information cannot be found.");
        }

        var headers = new List<(uint Name, uint Type, ulong Flags, ulong Address, ulong Offset, ulong Size)>(sectionCount);
        for (var index = 0; index < sectionCount; index++)
        {
            var at = sectionOffset + index * sectionEntrySize;
            headers.Add((
                ReadUInt32(bytes, at, isLittleEndian),
                ReadUInt32(bytes, at + 4, isLittleEndian),
                ReadUInt64(bytes, at + 8, isLittleEndian),
                ReadUInt64(bytes, at + 16, isLittleEndian),
                ReadUInt64(bytes, at + 24, isLittleEndian),
                ReadUInt64(bytes, at + 32, isLittleEndian)));
        }

        var names = headers[namesIndex];
        var sections = new List<ElfSection>(headers.Count);
        foreach (var header in headers)
        {
            var sectionName = ReadString(bytes, (long)(names.Offset + header.Name));
            sections.Add(new ElfSection(sectionName, header.Type, header.Flags, header.Address, header.Offset, header.Size));
        }

        return new ElfImage(path, bytes, is64Bit, isLittleEndian, machine, sections);
    }

    public ElfSection? Section(string name) => _byName.GetValueOrDefault(name);

    public bool HasSection(string name) => _byName.ContainsKey(name);

    /// <summary>The contents of a section, decompressed when the file stores it compressed.</summary>
    public byte[]? Data(string name)
    {
        var section = Section(name);
        if (section is null || section.Type == SectionTypeNoBits || section.Size == 0)
        {
            return null;
        }

        var start = (long)section.Offset;
        var length = (int)section.Size;
        if (start < 0 || length <= 0 || start + length > _bytes.Length)
        {
            return null;
        }

        if ((section.Flags & SectionFlagCompressed) == 0)
        {
            return _bytes.AsSpan((int)start, length).ToArray();
        }

        // A compressed section starts with a header: its type, the size of what it holds, and the
        // alignment. Only zlib is in use; a section compressed another way is left unread.
        if (ReadUInt32(_bytes, start, IsLittleEndian) != CompressionZlib)
        {
            return null;
        }

        var uncompressedSize = (long)ReadUInt64(_bytes, start + 8, IsLittleEndian);
        if (uncompressedSize <= 0 || length <= 24)
        {
            return null;
        }

        try
        {
            using var compressed = new MemoryStream(_bytes, (int)start + 24, length - 24);
            using var stream = new System.IO.Compression.ZLibStream(compressed, System.IO.Compression.CompressionMode.Decompress);
            var result = new byte[uncompressedSize];
            var read = stream.ReadAtLeast(result, result.Length, throwOnEndOfStream: false);
            return read == result.Length ? result : result[..read];
        }
        catch (Exception)
        {
            // A section that cannot be decompressed is treated as absent rather than as a crash.
            return null;
        }
    }

    /// <summary>
    /// The symbols of the image, from the full symbol table and falling back to the dynamic one. A
    /// stripped image has neither, and then only the debug file beside it knows the methods.
    /// </summary>
    public IReadOnlyList<ElfSymbol> Symbols()
    {
        _symbols ??= ReadSymbols(".symtab") ?? ReadSymbols(".dynsym") ?? [];
        return _symbols;
    }

    private List<ElfSymbol>? ReadSymbols(string name)
    {
        if (Section(name) is null)
        {
            return null;
        }

        var data = Data(name);
        var strings = Data(".strtab") ?? Data(".dynstr");
        if (data is null || strings is null || data.Length < SymbolEntrySize)
        {
            return null;
        }

        var result = new List<ElfSymbol>(data.Length / SymbolEntrySize);
        for (var at = 0; at + SymbolEntrySize <= data.Length; at += SymbolEntrySize)
        {
            result.Add(new ElfSymbol(
                ReadString(strings, ReadUInt32(data, at, IsLittleEndian)),
                ReadUInt64(data, at + 8, IsLittleEndian),
                ReadUInt64(data, at + 16, IsLittleEndian),
                data[at + 4] & 0x0f,
                ReadUInt16(data, at + 6, IsLittleEndian)));
        }

        return result;
    }

    /// <summary>
    /// The bytes of the code at an address. A stripped debug file keeps the address of a section but
    /// none of its contents, so the image is the one that has to be asked for the bytes.
    /// </summary>
    public byte[]? CodeAt(ulong address, int length)
    {
        foreach (var section in _sections)
        {
            if ((section.Flags & SectionFlagExecutable) == 0 || section.Type == SectionTypeNoBits)
            {
                continue;
            }

            if (address < section.Address || address + (ulong)length > section.Address + section.Size)
            {
                continue;
            }

            var offset = (long)(section.Offset + (address - section.Address));
            if (offset < 0 || offset + length > _bytes.Length)
            {
                continue;
            }

            return _bytes.AsSpan((int)offset, length).ToArray();
        }

        return null;
    }

    /// <summary>Whether the image holds code at the address at all, without reading it.</summary>
    public bool HasCodeAt(ulong address) =>
        _sections.Any(section =>
            (section.Flags & SectionFlagExecutable) != 0
            && section.Type != SectionTypeNoBits
            && address >= section.Address
            && address < section.Address + section.Size);

    /// <summary>The section an address belongs to, which is how code is told from data.</summary>
    public string? SectionOf(ulong address) =>
        _sections.FirstOrDefault(section =>
            (section.Type != SectionTypeNoBits)
            && address >= section.Address
            && address < section.Address + section.Size
            && (section.Flags & SectionFlagAllocated) != 0)?.Name;

    internal static uint ReadUInt32(byte[] bytes, long offset, bool littleEndian)
    {
        if (offset < 0 || offset + 4 > bytes.Length)
        {
            return 0;
        }

        var span = bytes.AsSpan((int)offset, 4);
        return littleEndian
            ? (uint)(span[0] | span[1] << 8 | span[2] << 16 | span[3] << 24)
            : (uint)(span[3] | span[2] << 8 | span[1] << 16 | span[0] << 24);
    }

    internal static ushort ReadUInt16(byte[] bytes, long offset, bool littleEndian)
    {
        if (offset < 0 || offset + 2 > bytes.Length)
        {
            return 0;
        }

        return littleEndian
            ? (ushort)(bytes[offset] | bytes[offset + 1] << 8)
            : (ushort)(bytes[offset + 1] | bytes[offset] << 8);
    }

    internal static ulong ReadUInt64(byte[] bytes, long offset, bool littleEndian)
    {
        var low = ReadUInt32(bytes, offset, littleEndian);
        var high = ReadUInt32(bytes, offset + 4, littleEndian);
        return littleEndian ? low | (ulong)high << 32 : (ulong)low << 32 | high;
    }

    internal static string ReadString(byte[] bytes, long offset)
    {
        if (offset < 0 || offset >= bytes.Length)
        {
            return string.Empty;
        }

        var end = offset;
        while (end < bytes.Length && bytes[end] != 0)
        {
            end++;
        }

        return System.Text.Encoding.UTF8.GetString(bytes, (int)offset, (int)(end - offset));
    }
}
