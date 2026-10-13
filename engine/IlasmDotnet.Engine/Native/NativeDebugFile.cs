namespace IlasmDotnet.Engine.Native;

/// <summary>
/// The debug information of a native image. A NativeAOT application is stripped when it is published,
/// and what remains in the image is a <c>.gnu_debuglink</c> entry naming the file that was taken out
/// of it: the arrangement a managed assembly has with its PDB, and the same reason to check that the
/// file really belongs to the image before a line table is believed. The entry carries a checksum of
/// that file, so a debug file left next to the wrong image is caught instead of misread.
/// </summary>
public static class NativeDebugFile
{
    /// <summary>The file that holds the debug information of the given image, or null when there is none.</summary>
    public static string? Find(string imagePath)
    {
        // The image may keep its own debug information, in which case it is the debug file.
        if (HasDebugSections(imagePath))
        {
            return imagePath;
        }

        var link = ReadLink(imagePath);
        if (link is null)
        {
            return null;
        }

        var (name, checksum) = link.Value;
        var directory = Path.GetDirectoryName(Path.GetFullPath(imagePath)) ?? ".";

        foreach (var candidate in new[]
                 {
                     Path.Combine(directory, name),
                     Path.Combine(directory, ".debug", name),
                     Path.Combine("/usr/lib/debug", directory.TrimStart('/'), name),
                 })
        {
            if (File.Exists(candidate) && Crc32(File.ReadAllBytes(candidate)) == checksum)
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>Whether the file carries DWARF sections itself.</summary>
    public static bool HasDebugSections(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            var header = new byte[64];
            if (stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false) < 64 || !ElfImage.LooksLikeElf(header))
            {
                return false;
            }

            return ElfImage.Open(path).HasSection(".debug_line");
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static (string Name, uint Checksum)? ReadLink(string imagePath)
    {
        try
        {
            var image = ElfImage.Open(imagePath);
            var data = image.Data(".gnu_debuglink");
            if (data is null || data.Length < 5)
            {
                return null;
            }

            var end = Array.IndexOf(data, (byte)0);
            if (end <= 0)
            {
                return null;
            }

            // The name is padded to a four byte boundary, and the checksum follows it.
            var checksumAt = (end + 4) & ~3;
            if (checksumAt + 4 > data.Length)
            {
                return null;
            }

            return (System.Text.Encoding.UTF8.GetString(data, 0, end), ElfImage.ReadUInt32(data, checksumAt, image.IsLittleEndian));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The checksum the linker writes into a debug link: CRC-32 as zlib computes it.</summary>
    public static uint Crc32(byte[] data)
    {
        var crc = 0xffffffffu;
        foreach (var value in data)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++)
            {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320u : crc >> 1;
            }
        }

        return crc ^ 0xffffffffu;
    }
}
