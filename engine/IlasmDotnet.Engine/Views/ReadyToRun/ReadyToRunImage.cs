using System.Buffers.Binary;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace IlasmDotnet.Engine.Views.ReadyToRun;

/// <summary>
/// One code block of a method, as it is stored in the image. The number of the block in the table of
/// the image is what the debug information of the image is indexed by, so it travels with the block.
/// </summary>
public sealed record ImageCode(int MethodToken, int StartRva, int Size, bool IsAdjacent, int FunctionIndex);

/// <summary>The architectures a ReadyToRun image can be read for.</summary>
public enum ImageArchitecture
{
    Unknown,
    X64,
    Arm64,
}

/// <summary>
/// Reads native code straight out of a ReadyToRun image, without a process and without the JIT.
///
/// Such an image carries a header that maps a method to the code block the compiler produced for it,
/// which is what makes the shipped code inspectable: nothing is run and nothing is recompiled, so the
/// listing is the code the application actually executes — also for an architecture the viewer does
/// not run on. Three tables are involved: <c>RuntimeFunctions</c> (every code block with its range),
/// <c>MethodDefEntryPoints</c> (a sparse array from the method row to the index of its block) and the
/// unwind data, which carries the size of the block on the targets that do not spell the range out in
/// the table.
///
/// What this cannot give is the mapping from a native instruction to an IL instruction: the image
/// keeps it in an undocumented section, so a listing from here is linked per method. Attach to a
/// running process for the exact instruction, see <see cref="Live.LiveAsmService"/>.
/// </summary>
public sealed class ReadyToRunImage
{
    private const uint Signature = 0x00525452; // 'RRR'
    private const uint RuntimeFunctionsSection = 102;
    private const uint MethodDefEntryPointsSection = 103;
    private const uint DebugInfoSection = 105;

    private readonly byte[] _image;
    private readonly Dictionary<uint, (int Rva, int Size)> _sections;
    private readonly (int VirtualAddress, int RawPointer, int VirtualSize, int RawSize)[] _headers;
    private readonly List<(int Start, int Size)> _functions = [];

    private ReadyToRunImage(
        byte[] image,
        Dictionary<uint, (int Rva, int Size)> sections,
        (int, int, int, int)[] headers,
        ushort major,
        ushort minor,
        Machine machine)
    {
        _image = image;
        _sections = sections;
        _headers = headers;
        MajorVersion = major;
        MinorVersion = minor;
        Machine = machine;
        Architecture = ArchitectureOf(machine);
    }

    public ushort MajorVersion { get; }

    public ushort MinorVersion { get; }

    public Machine Machine { get; }

    public ImageArchitecture Architecture { get; }

    /// <summary>True when the image carries a table of code blocks; a header without one holds no code.</summary>
    public bool HasRuntimeFunctions => _functions.Count > 0;

    /// <summary>
    /// Platform the machine type stands for, for the note shown when the code cannot be read.
    /// The values are the measured ones from <see cref="ArchitectureOf"/>.
    /// </summary>
    public string ArchitectureName => Machine switch
    {
        Machine.Amd64 => "win-x64",
        Machine.Arm64 => "win-arm64",
        (Machine)0xFD1D => "linux-x64",
        (Machine)0xC020 => "osx-x64",
        (Machine)0xD11D => "linux-arm64",
        (Machine)0xEC20 => "osx-arm64",
        (Machine)0x7ABD => "linux-arm",
        _ => $"machine 0x{(int)Machine:X4}",
    };

    /// <summary>
    /// Architecture a ReadyToRun image was built for, taken from its machine type.
    ///
    /// Windows images carry the usual machine type, while crossgen2 marks the unix targets with values
    /// of its own. The values below were read from an image published for each of those platforms and
    /// checked against the code the image contains, which is why they are spelled out rather than
    /// derived. An image of an unknown target is left to the other routes instead of being guessed at.
    /// </summary>
    public static ImageArchitecture ArchitectureOf(Machine machine) => machine switch
    {
        Machine.Amd64 => ImageArchitecture.X64,     // win-x64
        Machine.Arm64 => ImageArchitecture.Arm64,   // win-arm64
        (Machine)0xFD1D => ImageArchitecture.X64,   // linux-x64
        (Machine)0xC020 => ImageArchitecture.X64,   // osx-x64
        (Machine)0xD11D => ImageArchitecture.Arm64, // linux-arm64
        (Machine)0xEC20 => ImageArchitecture.Arm64, // osx-arm64
        _ => ImageArchitecture.Unknown,
    };

    /// <summary>
    /// Reads the image, or reports why it holds no code that can be read: a file that is not a
    /// ReadyToRun image at all is not a problem, a header that cannot be parsed is.
    /// </summary>
    public static ReadyToRunImage? TryLoad(string path, out string? note)
    {
        note = null;
        byte[] image;
        try
        {
            image = File.ReadAllBytes(path);
        }
        catch (IOException)
        {
            return null;
        }

        using var stream = new MemoryStream(image, writable: false);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata || pe.PEHeaders.CorHeader is null || pe.PEHeaders.CorHeader.ManagedNativeHeaderDirectory.Size <= 0)
        {
            return null;
        }

        var headers = pe.PEHeaders.SectionHeaders
            .Select(section => (section.VirtualAddress, section.PointerToRawData, section.VirtualSize, section.SizeOfRawData))
            .ToArray();

        var directory = pe.PEHeaders.CorHeader.ManagedNativeHeaderDirectory;
        var offset = ToOffset(headers, directory.RelativeVirtualAddress);
        if (offset < 0 || offset + 16 > image.Length || BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(offset)) != Signature)
        {
            return null;
        }

        var major = BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(offset + 4));
        var minor = BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(offset + 6));
        var count = BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(offset + 12));
        var sections = new Dictionary<uint, (int Rva, int Size)>();

        // Each section record is a type plus an IMAGE_DATA_DIRECTORY: an RVA and a size.
        for (var index = 0; index < count; index++)
        {
            var at = offset + 16 + (int)index * 12;
            if (at + 12 > image.Length)
            {
                note = $"{Path.GetFileName(path)} declares {count} ReadyToRun sections but the header holds fewer, so its table of methods cannot be read.";
                return null;
            }

            sections[BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(at))] = (
                BinaryPrimitives.ReadInt32LittleEndian(image.AsSpan(at + 4)),
                BinaryPrimitives.ReadInt32LittleEndian(image.AsSpan(at + 8)));
        }

        var result = new ReadyToRunImage(image, sections, headers, major, minor, pe.PEHeaders.CoffHeader.Machine);
        result.ReadRuntimeFunctions();

        if (!result.HasRuntimeFunctions)
        {
            note = $"{Path.GetFileName(path)} has a ReadyToRun header (version {major}.{minor}) but no readable table of methods, so the code it carries cannot be attributed.";
        }

        return result;
    }

    /// <summary>Code blocks of a method, in the order the compiler emitted them.</summary>
    public IReadOnlyList<ImageCode> CodeFor(MethodDefinitionHandle handle)
    {
        var token = MetadataTokens.GetToken(handle);
        var row = MetadataTokens.GetRowNumber(handle);
        if (row <= 0 || !_sections.TryGetValue(MethodDefEntryPointsSection, out var entryPoints) || entryPoints.Size <= 0)
        {
            return [];
        }

        // The sparse array is indexed by the method row counted from zero, so the lookup is a single
        // read of a table that only stores the rows that have code.
        if (!ImageDebugInfo.TryLookup(_image, ToOffset, entryPoints.Rva, row - 1, out var position)
            || !ImageDebugInfo.TryReadValue(_image, ToOffset, position, out var value))
        {
            return [];
        }

        // The low bit of the value says whether the entry carries a fixup blob, and the two bits after
        // it are used only when it does: the index of the block in the runtime function table takes a
        // different number of the low bits depending on that, which is what the runtime does too.
        var index = (value & 1) == 0 ? (int)(value >> 1) : (int)(value >> 2);
        if (index < 0 || index >= _functions.Count)
        {
            return [];
        }

        var result = new List<ImageCode> { new(token, _functions[index].Start, _functions[index].Size, false, index) };

        // A method body can be split into several blocks: a funclet or the cold part follows its hot
        // part in the image, so a block that starts exactly where the previous one ends belongs to the
        // same method. The listing marks such a block so the boundary stays visible.
        var next = index + 1;
        var end = _functions[index].Start + _functions[index].Size;
        while (next < _functions.Count && _functions[next].Start == end)
        {
            result.Add(new ImageCode(token, _functions[next].Start, _functions[next].Size, true, next));
            end += _functions[next].Size;
            next++;
        }

        return result;
    }

    /// <summary>
    /// The map from a machine instruction of a block to the IL instruction it implements, read out of
    /// the image itself. Null is the answer when the image holds no such map for the block, which is
    /// what a stripped image, an inlined method and a format the reader does not know look like.
    /// </summary>
    public IReadOnlyList<ImageMapping>? IlMapFor(ImageCode block, out string? note)
    {
        note = null;
        if (!_sections.TryGetValue(DebugInfoSection, out var section) || section.Size <= 0)
        {
            return null;
        }

        return ImageDebugInfo.Read(_image, ToOffset, section.Rva, block.FunctionIndex, MajorVersion, out note);
    }

    public byte[] Read(int startRva, int size)
    {
        var offset = ToOffset(startRva);
        if (offset < 0 || size <= 0 || offset + size > _image.Length)
        {
            return [];
        }

        return _image.AsSpan(offset, size).ToArray();
    }

    private void ReadRuntimeFunctions()
    {
        if (!_sections.TryGetValue(RuntimeFunctionsSection, out var section) || section.Size <= 0)
        {
            return;
        }

        var offset = ToOffset(section.Rva);
        if (offset < 0)
        {
            return;
        }

        // x64 spells out the end of the block; arm64 keeps the length in the unwind data instead.
        var x64 = Architecture == ImageArchitecture.X64;
        var entrySize = x64 ? 12 : 8;
        var end = Math.Min(offset + section.Size, _image.Length);

        for (var at = offset; at + entrySize <= end; at += entrySize)
        {
            var start = (int)BinaryPrimitives.ReadUInt32LittleEndian(_image.AsSpan(at));
            var size = x64
                ? (int)BinaryPrimitives.ReadUInt32LittleEndian(_image.AsSpan(at + 4)) - start
                : UnwindLength((int)BinaryPrimitives.ReadUInt32LittleEndian(_image.AsSpan(at + 4)));

            if (start > 0 && size > 0)
            {
                _functions.Add((start, size));
            }
        }
    }

    /// <summary>
    /// Size of a function taken from its unwind data: the first two bytes of the record count the four
    /// byte instructions of the function, which is where arm64 keeps the length the table omits.
    /// </summary>
    private int UnwindLength(int unwindRva)
    {
        var offset = ToOffset(unwindRva);
        return offset < 0 || offset + 2 > _image.Length
            ? 0
            : BinaryPrimitives.ReadUInt16LittleEndian(_image.AsSpan(offset)) * 4;
    }

    private int ToOffset(int rva) => ToOffset(_headers, rva);

    private static int ToOffset((int VirtualAddress, int RawPointer, int VirtualSize, int RawSize)[] headers, int rva)
    {
        foreach (var header in headers)
        {
            var size = Math.Max(header.VirtualSize, header.RawSize);
            if (rva >= header.VirtualAddress && rva < header.VirtualAddress + size)
            {
                return header.RawPointer + (rva - header.VirtualAddress);
            }
        }

        return -1;
    }
}
