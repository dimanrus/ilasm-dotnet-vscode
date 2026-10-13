using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace IlasmDotnet.Engine.Bundle;

/// <summary>What a file inside a single file bundle is, as the manifest spells it.</summary>
public enum BundleFileType
{
    Unknown = 0,
    Assembly = 1,
    NativeBinary = 2,
    DepsJson = 3,
    RuntimeConfigJson = 4,
    Symbols = 5,
}

/// <summary>One file of a bundle: where its bytes are, and how long they are.</summary>
public sealed record BundleFile(BundleFileType Type, string RelativePath, long Offset, long Size, long CompressedSize)
{
    /// <summary>Whether the bytes of the file are stored deflated rather than as they are.</summary>
    public bool IsCompressed => CompressedSize > 0 && CompressedSize != Size;

    /// <summary>How many bytes of the file the bundle holds.</summary>
    public long StoredSize => IsCompressed ? CompressedSize : Size;
}

/// <summary>
/// A program published into a single file: the host executable with the assemblies of the application
/// appended to it, followed by a manifest that says where each of them lies.
///
/// Nothing of the application is in the host itself — the file is a native image whose payload is a
/// set of managed assemblies — so the metadata reader sees a native executable where it expects a
/// .dll, and the native route sees a stripped image with no methods of its own. This takes a bundle
/// apart far enough for the rest of the viewer: it finds the manifest, hands out the bytes of a file
/// inside, and can lay them out beside each other in a directory, which is what every other reader
/// needs to work on an application published this way.
/// </summary>
public sealed class SingleFileApplication : IDisposable
{
    /// <summary>How much of the end of a file is searched for the manifest.</summary>
    private const int TailBytes = 1024 * 1024;

    private const int EntryHeaderBytes = 25;
    private const int MaximumPathBytes = 4096;

    /// <summary>How much of a compressed file is deflated to look at its first bytes.</summary>
    private const int UnpackedHeaderBytes = 1024;

    private readonly FileStream _stream;
    private readonly byte[] _tail;

    /// <summary>Where the tail starts in the file, since the manifest is found within it.</summary>
    private readonly long _tailOffset;

    private SingleFileApplication(
        string path,
        FileStream stream,
        long length,
        long tailOffset,
        byte[] tail,
        IReadOnlyList<BundleFile> files)
    {
        Path = path;
        _stream = stream;
        Length = length;
        _tailOffset = tailOffset;
        _tail = tail;
        Files = files;
    }

    public string Path { get; }

    public long Length { get; }

    /// <summary>The files of the bundle, in the order the manifest lists them.</summary>
    public IReadOnlyList<BundleFile> Files { get; }

    /// <summary>Whether the file is a single file bundle this reader understands.</summary>
    public static bool LooksLikeBundle(string path)
    {
        var bundle = TryOpen(path);
        try
        {
            return bundle is not null;
        }
        finally
        {
            bundle?.Dispose();
        }
    }

    public static SingleFileApplication? TryOpen(string path)
    {
        FileStream? stream = null;
        try
        {
            stream = File.OpenRead(path);
            var length = stream.Length;
            if (length < 64)
            {
                stream.Dispose();
                return null;
            }

            var tailLength = (int)Math.Min(length, TailBytes);
            var tail = new byte[tailLength];
            stream.Position = length - tailLength;
            stream.ReadExactly(tail, 0, tailLength);

            var bundle = new SingleFileApplication(System.IO.Path.GetFullPath(path), stream, length, length - tailLength, tail, []);
            var files = bundle.ReadManifest();
            if (files is null)
            {
                stream.Dispose();
                return null;
            }

            return new SingleFileApplication(bundle.Path, stream, length, length - tailLength, tail, files);
        }
        catch (Exception)
        {
            stream?.Dispose();
            return null;
        }
    }

    /// <summary>
    /// Finds the manifest at the end of the file and reads it. There is no marker to look for: the
    /// host is patched with the offset of the header and knows it by heart, so the way in is to look
    /// for a place where the entries of a manifest parse and end exactly where the file ends. A bad
    /// reading is almost impossible, because every entry says where its bytes lie and how long they
    /// are, and an offset outside the file, a length running past its end or a name that is not
    /// printable all end the attempt. The count of files stands right in front of the manifest, and
    /// the first assembly it names has to start with the header of a portable executable.
    /// </summary>
    private IReadOnlyList<BundleFile>? ReadManifest()
    {
        List<BundleFile>? fallback = null;

        for (var start = 0; start + EntryHeaderBytes <= _tail.Length; start++)
        {
            // The kind of a file is one byte at a fixed place in an entry, which is the cheap filter
            // that keeps the scan from parsing at every byte of the tail.
            if (_tail[start + 24] is < 1 or > 6)
            {
                continue;
            }

            var files = ReadEntries(start);
            if (files is null || files.Count == 0)
            {
                continue;
            }

            // The bytes of every file of a bundle lie in front of its manifest, and the reading has to
            // agree with that before it is believed. The manifest is found as a place within the tail,
            // so where it lies in the file itself is what the offsets of the files are held against.
            var manifestOffset = _tailOffset + start;
            if (files.Any(file => file.Offset + file.StoredSize > manifestOffset))
            {
                continue;
            }

            if (!HoldsAssembly(files))
            {
                continue;
            }

            // The header of a bundle names the number of files and the name of the application, and
            // its fields lie between the count and the manifest. A reading whose header agrees with it
            // is the one; anything else is kept as a fallback so that a bundler that lays its header
            // out differently stays readable instead of being refused.
            if (MatchesHeader(start, files.Count))
            {
                return files;
            }

            fallback ??= files;
        }

        return fallback;
    }

    /// <summary>
    /// Whether the header in front of a manifest describes the bundle that was read from it. The
    /// header is laid out backwards from the manifest: a flags word, the offsets and sizes of the two
    /// configuration files, the name of the bundle, and in front of all of those the count of files
    /// and the version of the format.
    /// </summary>
    private bool MatchesHeader(int manifestStart, int fileCount)
    {
        var afterName = manifestStart - (8 + 8 + 8 + 8 + 8);
        for (var nameLength = 1; nameLength <= 255 && afterName - nameLength - 1 - 12 >= 0; nameLength++)
        {
            var nameStart = afterName - nameLength;
            if (_tail[afterName - nameLength - 1] != nameLength)
            {
                continue;
            }

            var countAt = nameStart - 4;
            var minorAt = countAt - 4;
            var majorAt = minorAt - 4;

            var count = BitConverter.ToInt32(_tail, countAt);
            var minor = BitConverter.ToUInt32(_tail, minorAt);
            var major = BitConverter.ToUInt32(_tail, majorAt);

            if (count == fileCount && major is >= 1 and <= 99 && minor is >= 0 and <= 9)
            {
                return true;
            }
        }

        return false;
    }

    private List<BundleFile>? ReadEntries(int start)
    {
        var files = new List<BundleFile>();
        var at = start;

        while (at < _tail.Length)
        {
            if (at + EntryHeaderBytes > _tail.Length)
            {
                return null;
            }

            var offset = BitConverter.ToInt64(_tail, at);
            var size = BitConverter.ToInt64(_tail, at + 8);
            var compressed = BitConverter.ToInt64(_tail, at + 16);
            var type = _tail[at + 24];
            at += EntryHeaderBytes;

            if (type is < 1 or > 6 || size < 0 || offset < 0 || compressed < 0)
            {
                return null;
            }

            // The length of the name is written as a variable length integer, the one shape of number
            // this format uses for strings.
            var pathLength = 0;
            var shift = 0;
            while (at < _tail.Length)
            {
                var value = _tail[at++];
                pathLength |= (value & 0x7f) << shift;
                if ((value & 0x80) == 0)
                {
                    break;
                }

                shift += 7;
                if (shift > 21)
                {
                    return null;
                }
            }

            if (pathLength is <= 0 or > MaximumPathBytes || at + pathLength > _tail.Length)
            {
                return null;
            }

            var name = Encoding.UTF8.GetString(_tail, at, pathLength);
            at += pathLength;

            // A compressed entry lies in the file as its deflated self, which is shorter than the file
            // it stands for, so the reach of an entry is measured by the bytes the bundle holds.
            var stored = compressed > 0 && compressed != size ? compressed : size;
            if (!IsPlausibleName(name) || offset + stored > Length || compressed > size)
            {
                return null;
            }

            files.Add(new BundleFile((BundleFileType)type, name, offset, size, compressed));
        }

        return files;
    }

    /// <summary>
    /// Whether an assembly the manifest names really starts with a portable executable. The bytes are
    /// asked of the file itself rather than of the tail: a self contained bundle holds most of its
    /// assemblies far from the end, where the tail of a large file does not reach.
    /// </summary>
    private bool HoldsAssembly(IReadOnlyList<BundleFile> files)
    {
        foreach (var file in files)
        {
            if (file.Type == BundleFileType.Assembly && file.Size >= 2 && StartsWithPortableExecutable(file))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether the bytes of a file of the bundle begin with the header of a portable executable. The
    /// beginning of a large assembly is enough, and a bundle that compresses its files has to have
    /// that beginning deflated first.
    /// </summary>
    private bool StartsWithPortableExecutable(BundleFile file)
    {
        var stored = (int)Math.Min(file.StoredSize, UnpackedHeaderBytes);
        if (stored < 2)
        {
            return false;
        }

        var raw = new byte[stored];
        _stream.Position = file.Offset;
        _stream.ReadExactly(raw, 0, stored);

        var header = new byte[2];
        try
        {
            if (!file.IsCompressed)
            {
                header[0] = raw[0];
                header[1] = raw[1];
            }
            else
            {
                using var compressed = new MemoryStream(raw);
                using var deflated = new DeflateStream(compressed, CompressionMode.Decompress);
                var read = 0;
                while (read < header.Length)
                {
                    var count = deflated.Read(header, read, header.Length - read);
                    if (count == 0)
                    {
                        break;
                    }

                    read += count;
                }

                if (read < header.Length)
                {
                    return false;
                }
            }
        }
        catch (InvalidDataException)
        {
            return false;
        }

        return header[0] == (byte)'M' && header[1] == (byte)'Z';
    }

    private static bool IsPlausibleName(string name)
    {
        if (name.Length == 0 || name.Contains("..", StringComparison.Ordinal) || System.IO.Path.IsPathRooted(name))
        {
            return false;
        }

        foreach (var character in name)
        {
            if (character < 32 || character > 126)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>The bytes of one file of the bundle, decompressed when it is stored compressed.</summary>
    public byte[] Read(BundleFile file)
    {
        var stored = (int)file.StoredSize;
        var raw = new byte[stored];
        _stream.Position = file.Offset;
        _stream.ReadExactly(raw, 0, stored);

        if (!file.IsCompressed)
        {
            return raw;
        }

        // A compressed entry is a deflate stream of the bytes of the file.
        using var compressed = new MemoryStream(raw);
        using var deflated = new DeflateStream(compressed, CompressionMode.Decompress);
        var result = new byte[file.Size];
        deflated.ReadExactly(result, 0, result.Length);
        return result;
    }

    /// <summary>
    /// The assembly the executable stands for: the one named after it. The host itself is a native
    /// program, so every method a reader cares about lives in this assembly.
    /// </summary>
    public BundleFile? EntryAssembly()
    {
        var assemblies = Files.Where(file => file.Type == BundleFileType.Assembly).ToList();
        if (assemblies.Count == 0)
        {
            return null;
        }

        foreach (var name in NamesOfTheApplication())
        {
            var match = assemblies.FirstOrDefault(file =>
                string.Equals(System.IO.Path.GetFileName(file.RelativePath), name, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                return match;
            }
        }

        return assemblies.Count == 1 ? assemblies[0] : null;
    }

    /// <summary>
    /// What the application is called, taken from the file names a bundle always carries: the name of
    /// the executable and the configuration files it holds, which are named after the application.
    /// </summary>
    private IEnumerable<string> NamesOfTheApplication()
    {
        var executable = System.IO.Path.GetFileName(Path);
        if (executable.Length > 0)
        {
            yield return executable + ".dll";
            yield return System.IO.Path.GetFileNameWithoutExtension(executable) + ".dll";
        }

        foreach (var file in Files)
        {
            if (file.Type is BundleFileType.DepsJson or BundleFileType.RuntimeConfigJson)
            {
                var name = System.IO.Path.GetFileName(file.RelativePath);
                var suffix = file.Type == BundleFileType.DepsJson ? ".deps.json" : ".runtimeconfig.json";
                if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                {
                    yield return name[..^suffix.Length] + ".dll";
                }
            }
        }
    }

    /// <summary>
    /// Writes the managed files of the bundle into a directory and returns the entry assembly there.
    /// Native binaries are left out: they are what makes a self contained bundle large, and nothing
    /// that reads metadata or hands a method to the JIT needs them beside the assemblies.
    ///
    /// A file that is already there in the length it should have is left alone: the directory is named
    /// after the stamp of the bundle, so what it holds belongs to the bundle that is being read, and a
    /// self contained bundle of a hundred files would otherwise be written out on every read.
    /// </summary>
    public string? ExtractTo(string directory)
    {
        Directory.CreateDirectory(directory);

        var entry = EntryAssembly();
        string? entryPath = null;

        foreach (var file in Files)
        {
            if (file.Type is BundleFileType.NativeBinary or BundleFileType.Unknown)
            {
                continue;
            }

            var destination = System.IO.Path.Combine(directory, file.RelativePath);
            var parent = System.IO.Path.GetDirectoryName(destination);
            if (parent is not null)
            {
                Directory.CreateDirectory(parent);
            }

            if (!HasSize(destination, file.Size))
            {
                File.WriteAllBytes(destination, Read(file));
            }

            if (entry is not null && string.Equals(file.RelativePath, entry.RelativePath, StringComparison.Ordinal))
            {
                entryPath = destination;
            }
        }

        return entryPath;
    }

    private static bool HasSize(string path, long size)
    {
        var info = new FileInfo(path);
        return info.Exists && info.Length == size;
    }

    /// <summary>
    /// The directory a bundle is taken apart into. It is derived from the path and the stamp of the
    /// file, so a rebuilt executable is read from a fresh directory and the previous one stops being
    /// used instead of being read as the new build.
    /// </summary>
    public string ExtractionDirectory()
    {
        var info = new FileInfo(Path);
        var identity = $"{Path}|{info.Length}|{info.LastWriteTimeUtc.Ticks}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..16];

        return System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ilasm-dotnet-bundle", hash.ToLowerInvariant());
    }

    public void Dispose() => _stream.Dispose();
}
