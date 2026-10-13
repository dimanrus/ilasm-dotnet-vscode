using System.Reflection.PortableExecutable;

namespace IlasmDotnet.Engine.Metadata;

/// <summary>
/// Tells a managed assembly apart from the files that are not one, so that pointing the viewer at a
/// NativeAOT binary or at an ordinary native library ends with an explanation instead of "unknown
/// file format". A native image is not a damaged assembly: its method bodies are machine code, so
/// there is no IL, no C# and no method map in it for any view to show, whatever the view is asked for.
/// </summary>
public static class NativeImage
{
    /// <summary>Why the file cannot be read as an assembly, or null when it can be.</summary>
    public static string? Explain(string path)
    {
        byte[] header = new byte[20];
        int read;
        try
        {
            using var stream = File.OpenRead(path);
            read = stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false);
        }
        catch (Exception)
        {
            // A file that cannot even be opened is reported by the reader, which is where the
            // difference between a missing file and an unreadable one belongs.
            return null;
        }

        if (read < 4)
        {
            return $"{Name(path)} is {read} bytes long, which is too short to be an assembly.";
        }

        if (header[0] == 0x7f && header[1] == (byte)'E' && header[2] == (byte)'L' && header[3] == (byte)'F')
        {
            var machine = read >= 20 ? $" for {Describe(MachineOf(header))}" : string.Empty;
            return $"{Name(path)} is a native ELF image{machine}, not a managed assembly. " + NoIl;
        }

        var magic = (uint)(header[0] << 24 | header[1] << 16 | header[2] << 8 | header[3]);
        if (magic is 0xFEEDFACE or 0xFEEDFACF or 0xCEFAEDFE or 0xCFFAEDFE or 0xCAFEBABE or 0xBEBAFECA)
        {
            return $"{Name(path)} is a native Mach-O image (macOS), not a managed assembly. " + NoIl;
        }

        if (header[0] != (byte)'M' || header[1] != (byte)'Z')
        {
            return $"{Name(path)} is not a .NET assembly: it starts with neither a PE (MZ) nor an ELF header.";
        }

        try
        {
            using var pe = new PEReader(File.OpenRead(path));
            return pe.HasMetadata
                ? null
                : $"{Name(path)} is a native PE image, not a managed assembly. " + NoIl;
        }
        catch (BadImageFormatException)
        {
            return $"{Name(path)} starts with an MZ header but the PE header behind it cannot be read, so it is not a .NET assembly.";
        }
    }

    private const string NoIl =
        "A native image holds machine code and no IL, so there is nothing for an IL or C# view to read "
        + "here. A binary published with NativeAOT looks like this: its method bodies exist only as native code. "
        + "The machine code itself can be shown: the viewer reads native images of its own.";

    private static string Name(string path) => Path.GetFileName(path);

    /// <summary>The machine of an ELF image, as the word appears in its header.</summary>
    private static ushort MachineOf(byte[] header)
    {
        // e_ident[5] is the endianness of the file, e_machine is a word at offset 18.
        return header[5] == 2
            ? (ushort)(header[18] << 8 | header[19])
            : (ushort)(header[19] << 8 | header[18]);
    }

    private static string Describe(ushort machine) => machine switch
    {
        0x03 => "i386",
        0x08 => "MIPS",
        0x14 => "PowerPC",
        0x15 => "PowerPC64",
        0x28 => "ARM",
        0x2b => "SPARC",
        0x3e => "x86-64",
        0xb7 => "AArch64",
        0xf3 => "RISC-V",
        _ => $"an unnamed machine (0x{machine:x})",
    };
}
