using System.Buffers.Binary;

namespace IlasmDotnet.Engine.Views.ReadyToRun;

/// <summary>One place where the machine code of a method starts implementing an IL instruction.</summary>
public readonly record struct ImageMapping(int NativeOffset, int IlOffset, int Source)
{
    /// <summary>What the runtime writes when the code stands for no instruction of the method.</summary>
    public const int NoMapping = -1;

    public const int Prolog = -2;

    public const int Epilog = -3;

    /// <summary>What a listing says about an instruction: the IL instruction it implements, or why it
    /// implements none.</summary>
    public string Label => IlOffset switch
    {
        Prolog => "prolog",
        Epilog => "epilog",
        < 0 => "no IL",
        _ => $"IL_{IlOffset:x4}",
    };
}

/// <summary>
/// The map from a machine instruction to the IL instruction it implements, read out of a ReadyToRun
/// image. The compiler writes it for a debugger: per method a blob whose head names how long the two
/// parts of it are, followed by the list of places where the machine code starts standing for another
/// instruction of the method. Reading it is what turns a listing of an image into a listing that is
/// linked to IL without a process being attached.
///
/// Two encodings of the list exist, and the version of the image tells them apart. Up to version 15
/// the numbers of an entry — the distance to the previous place, the IL offset and the kind of the
/// place — follow one another as variable length integers, three bits per nibble. From version 16 they
/// are packed into one field of a fixed width per entry, with the two widths written in the head of
/// the part, which is smaller and quicker to walk. Both are read here, because images of both kinds
/// are still shipped: 8.0 images carry the older one, 9.0 and later the newer.
/// </summary>
public static class ImageDebugInfo
{
    /// <summary>The version of the image from which the entries are packed rather than run together.</summary>
    private const int PackedFormatVersion = 16;

    /// <summary>How many bits the kind of a place takes in the packed encoding.</summary>
    private const int SourceBits = 2;

    /// <summary>A map longer than this is not believed: it would be a misreading of the head.</summary>
    private const int MaximumMappings = 100_000;

    /// <summary>
    /// The map of one runtime function, or null when the image holds none — a stripped image, a method
    /// the compiler inlined, or a format this reader does not know. A reason is given when the map is
    /// there but could not be read.
    /// </summary>
    public static IReadOnlyList<ImageMapping>? Read(
        byte[] image,
        Func<int, int> toOffset,
        int sectionRva,
        int functionIndex,
        int majorVersion,
        out string? note)
    {
        note = null;

        if (!TryLookup(image, toOffset, sectionRva, functionIndex, out var position))
        {
            return null;
        }

        // An element stands for its blob in one of two ways: a zero means the blob follows the element
        // right away, and any other value is the distance back to a blob that lies before it. The
        // second form is what deduplication produces — the compiler writes one blob per distinct map
        // and lets the methods that share it point at the same one, so a method whose map is the same
        // as an earlier method's has its blob behind the element rather than in front of it.
        var (value, size) = ReadUnsigned(image, toOffset, position);
        var blobRva = value != 0 ? position - (int)value : position + size;

        var header = new NibbleReader(image, toOffset, blobRva);
        var boundsLength = header.EncodedU32();
        if (boundsLength == 0)
        {
            // A "fat" head, written when the blob carries more than the offsets and the variables of a
            // method: the lengths of all the parts follow, and only the first one matters here.
            boundsLength = header.EncodedU32();
            header.EncodedU32();
            for (var index = 0; index < 4; index++)
            {
                header.EncodedU32();
            }
        }
        else
        {
            header.EncodedU32();
        }

        if (boundsLength <= 0)
        {
            return null;
        }

        var boundsRva = blobRva + header.NextByte();
        return majorVersion >= PackedFormatVersion
            ? ReadPacked(image, toOffset, boundsRva, (int)boundsLength, out note)
            : ReadRuns(image, toOffset, boundsRva, out note);
    }

    /// <summary>
    /// The older encoding: the head of the part names the number of entries, and every entry follows as
    /// three variable length integers. Distances are counted from the previous entry, and the IL offset
    /// is stored shifted by the sentinel the runtime uses, which is how a prolog, an epilog and code
    /// that stands for nothing are told apart from an instruction.
    /// </summary>
    private static IReadOnlyList<ImageMapping>? ReadRuns(byte[] image, Func<int, int> toOffset, int boundsRva, out string? note)
    {
        note = null;
        var reader = new NibbleReader(image, toOffset, boundsRva);
        var count = reader.EncodedU32();
        if (count is <= 0 or > MaximumMappings)
        {
            note = "the image names an implausible number of places where its code turns into IL.";
            return null;
        }

        var result = new List<ImageMapping>((int)count);
        var nativeOffset = 0;
        for (var index = 0; index < count; index++)
        {
            nativeOffset += (int)reader.EncodedU32();
            var ilOffset = (int)reader.EncodedU32() + ImageMapping.Epilog;
            var source = (int)reader.EncodedU32();
            result.Add(new ImageMapping(nativeOffset, ilOffset, source));
        }

        return result;
    }

    /// <summary>
    /// The encoding of version 16 and later: the head names the number of entries and the widths of two
    /// of the three numbers of an entry, and the entries follow as bit fields of that width. The kind
    /// of the place has a fixed width of two bits.
    /// </summary>
    private static IReadOnlyList<ImageMapping>? ReadPacked(
        byte[] image,
        Func<int, int> toOffset,
        int boundsRva,
        int boundsLength,
        out string? note)
    {
        note = null;
        var reader = new NibbleReader(image, toOffset, boundsRva);
        var count = reader.EncodedU32();
        var nativeBits = (int)reader.EncodedU32() + 1;
        var ilBits = (int)reader.EncodedU32() + 1;

        var width = SourceBits + nativeBits + ilBits;
        var array = reader.NextByte();
        if (count is <= 0 or > MaximumMappings || nativeBits > 32 || ilBits > 32 || array + (count * width + 7) / 8 > boundsLength)
        {

            note = "the image names an implausible layout for the places where its code turns into IL.";
            return null;
        }

        var result = new List<ImageMapping>((int)count);
        var nativeOffset = 0;
        var bits = new BitReader(image, toOffset, boundsRva + array);
        for (var index = 0; index < count; index++)
        {
            var entry = bits.Read(width);
            var source = (int)(entry & (SourceBits - 1));
            nativeOffset += (int)((entry >> SourceBits) & ((1u << nativeBits) - 1));
            var ilOffset = (int)((entry >> (SourceBits + nativeBits)) & ((1u << ilBits) - 1)) + ImageMapping.Epilog;
            result.Add(new ImageMapping(nativeOffset, ilOffset, source));
        }

        return result;
    }

    /// <summary>The value of the entry at the given place, which is what the entry stands for.</summary>
    public static bool TryReadValue(byte[] image, Func<int, int> toOffset, int rva, out uint value)
    {
        var (read, _) = ReadUnsigned(image, toOffset, rva);
        value = read;
        return toOffset(rva) >= 0;
    }

    /// <summary>
    /// Where the value of the entry with the given index lies. The section holds a sparse array indexed
    /// by the number of the runtime function, laid out as a small binary tree per block of sixteen
    /// entries: a node says which of the two children it has, and the child on the left follows it.
    /// </summary>
    public static bool TryLookup(byte[] image, Func<int, int> toOffset, int sectionRva, int index, out int position)
    {
        position = 0;
        var (header, headerSize) = ReadUnsigned(image, toOffset, sectionRva);
        var entrySize = 1 << (int)(header & 3);
        if (index < 0 || index >= header >> 2)
        {
            return false;
        }

        var blockBase = sectionRva + headerSize;
        var blockEntry = blockBase + entrySize * (index / 16);
        var offset = toOffset(blockEntry);
        if (offset < 0 || offset + entrySize > image.Length)
        {
            return false;
        }

        var blockOffset = entrySize switch
        {
            1 => image[offset],
            2 => BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(offset)),
            _ => BinaryPrimitives.ReadInt32LittleEndian(image.AsSpan(offset)),
        };

        position = blockBase + blockOffset;
        var within = index % 16;

        foreach (var bit in new[] { 8, 4, 2, 1 })
        {
            var (node, nodeSize) = ReadUnsigned(image, toOffset, position);
            if ((within & bit) != 0)
            {
                if ((node & 2) == 0)
                {
                    return false;
                }

                position += (int)(node >> 2);
                continue;
            }

            if ((node & 1) != 0)
            {
                position += nodeSize;
                continue;
            }

            // A node with neither child names the key it holds itself, and its value follows it. Any
            // other node without a child on this side means the array never got this key.
            if ((node & 2) == 0 && (node >> 2) == (uint)within)
            {
                position += nodeSize;
                break;
            }

            return false;
        }

        return toOffset(position) >= 0;
    }

    /// <summary>
    /// The variable length integer encoding of the native format: how many bytes a value takes is held
    /// in the low bits of its first byte, so a small number costs one byte and the widest form holds a
    /// full word of four.
    /// </summary>
    private static (uint Value, int Size) ReadUnsigned(byte[] image, Func<int, int> toOffset, int rva)
    {
        var offset = toOffset(rva);
        if (offset < 0 || offset + 5 > image.Length)
        {
            return (0, 1);
        }

        var first = image[offset];
        if ((first & 1) == 0)
        {
            return ((uint)(first >> 1), 1);
        }

        if ((first & 2) == 0)
        {
            return ((uint)((first >> 2) | (image[offset + 1] << 6)), 2);
        }

        if ((first & 4) == 0)
        {
            return ((uint)((first >> 3) | (image[offset + 1] << 5) | (image[offset + 2] << 13)), 3);
        }

        if ((first & 8) == 0)
        {
            return (
                (uint)((first >> 4) | (image[offset + 1] << 4) | (image[offset + 2] << 12) | (image[offset + 3] << 20)),
                4);
        }

        return (BinaryPrimitives.ReadUInt32LittleEndian(image.AsSpan(offset + 1)), 5);
    }

    /// <summary>
    /// A stream of nibbles packed two to a byte, low one first, where every nibble holds three bits of
    /// a number and says with its top bit whether the number goes on.
    /// </summary>
    private ref struct NibbleReader(byte[] image, Func<int, int> toOffset, int rva)
    {
        private readonly byte[] _image = image;
        private readonly Func<int, int> _toOffset = toOffset;
        private readonly int _start = rva;
        private int _nibbles;

        public uint EncodedU32()
        {
            var value = 0u;
            for (var guard = 0; guard < 11; guard++)
            {
                var nibble = Next();
                value = (value << 3) + (uint)(nibble & 7);
                if ((nibble & 8) == 0)
                {
                    return value;
                }
            }

            return value;
        }

        /// <summary>How many whole bytes the stream has consumed, a number of nibbles rounded up.</summary>
        public int NextByte() => (_nibbles + 1) / 2;

        private int Next()
        {
            var offset = _toOffset(_start + _nibbles / 2);
            if (offset < 0 || offset >= _image.Length)
            {
                return 0;
            }

            var packed = _image[offset];
            _nibbles++;
            return (_nibbles & 1) != 0 ? packed & 0xF : packed >> 4;
        }
    }

    /// <summary>A stream of numbers of a fixed width, the low bits of an entry first.</summary>
    private ref struct BitReader(byte[] image, Func<int, int> toOffset, int rva)
    {
        private readonly byte[] _image = image;
        private readonly Func<int, int> _toOffset = toOffset;
        private readonly int _start = rva;
        private int _bits;

        public uint Read(int width)
        {
            var value = 0u;
            for (var index = 0; index < width; index++)
            {
                var bit = _bits + index;
                var offset = _toOffset(_start + bit / 8);
                if (offset >= 0 && offset < _image.Length && ((_image[offset] >> (bit % 8)) & 1) != 0)
                {
                    value |= 1u << index;
                }
            }

            _bits += width;
            return value;
        }
    }
}
