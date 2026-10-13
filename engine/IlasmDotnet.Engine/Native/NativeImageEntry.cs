using IlasmDotnet.Engine.Model;
using IlasmDotnet.Engine.Views.ReadyToRun;

namespace IlasmDotnet.Engine.Native;

/// <summary>One method of a native image: where its code is, and what the debug information calls it.</summary>
public sealed record NativeMethod(
    int Address,
    int Size,
    string Name,
    string DeclaringType,
    string FullName,
    string File,
    int Line,
    string Symbol,
    bool IsRuntime);

/// <summary>
/// A native image opened for reading. A NativeAOT application has no IL, so the views that need it
/// have nothing to show for one; what the image does have is machine code and, beside it, the debug
/// information the compiler wrote, which says which method lies where and which line of source each
/// address came from. This turns that into a listing that can be navigated, and it is the whole of
/// the native route.
/// </summary>
public sealed class NativeImageEntry : IDisposable
{
    private readonly ElfImage _image;
    private readonly ElfImage? _debug;
    private readonly DwarfLineTable? _lines;
    private readonly DwarfNames? _names;
    private List<NativeMethod>? _methods;

    private NativeImageEntry(string path, ElfImage image, ElfImage? debug, string? debugPath, DwarfLineTable? lines, DwarfNames? names, string? note)
    {
        Path = path;
        _image = image;
        _debug = debug;
        _lines = lines;
        _names = names;
        Note = note;
        DebugFile = debugPath;
    }

    public string Path { get; }

    /// <summary>The name of the image without its extension, which is the name of its assembly.</summary>
    public string Name => System.IO.Path.GetFileNameWithoutExtension(Path);

    public string MachineName => _image.MachineName;

    /// <summary>The file the line table was read from, when it is not the image itself.</summary>
    public string? DebugFile { get; }

    /// <summary>What could not be read, which is what the reader has to know to trust the view.</summary>
    public string? Note { get; }

    public int MethodCount => Methods.Count;

    /// <summary>
    /// Every method the image holds. The ones whose source file is on this machine come first, because
    /// those are the ones a reader can navigate to.
    /// </summary>
    public IReadOnlyList<NativeMethod> Methods
    {
        get
        {
            _methods ??= ReadMethods();
            return _methods;
        }
    }

    public static NativeImageEntry Open(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var image = ElfImage.Open(full);

        var debugPath = NativeDebugFile.Find(full);
        ElfImage? debug = null;
        string? note = null;

        if (debugPath is null)
        {
            note = image.HasSection(".gnu_debuglink")
                ? $"the debug file of {System.IO.Path.GetFileName(full)} is missing or does not belong to it"
                : $"no debug information was found for {System.IO.Path.GetFileName(full)}";
        }
        else if (!string.Equals(debugPath, full, StringComparison.Ordinal))
        {
            debug = ElfImage.Open(debugPath);
        }

        var source = debug ?? image;
        var lines = source.HasSection(".debug_line") ? DwarfLineTable.Load(source) : null;
        var names = source.HasSection(".debug_info") ? DwarfNames.Load(source) : null;

        // Every part of the route can come up short on its own: no debug file, no line table, names
        // that could not be read. The reader is told all of it, because each one means something
        // different about what the listing shows.
        var troubles = new[] { note, names?.Note, lines?.Note }.Where(message => message is not null);
        return new NativeImageEntry(full, image, debug, debugPath, lines, names, string.Join("; ", troubles));
    }

    /// <summary>The methods whose code was compiled from one file, which is what a file view shows.</summary>
    public IReadOnlyList<NativeMethod> MethodsOfFile(string file) =>
        Methods.Where(method => method.File.Length > 0 && SameFile(method.File, file)).ToList();

    /// <summary>The method that starts at an address, which is how a view names the code it shows.</summary>
    public NativeMethod? MethodAt(int address) => Methods.FirstOrDefault(method => method.Address == address);

    /// <summary>
    /// The method a line of a file belongs to. The debug information names the line a method starts
    /// on, so the method of a line is the last one declared at or before it - the same rule the
    /// managed route uses with the lines a PDB maps.
    /// </summary>
    public NativeMethod? MethodBySource(string file, int line)
    {
        var candidates = MethodsOfFile(file);
        if (candidates.Count == 0)
        {
            return null;
        }

        var best = candidates
            .Where(method => method.Line > 0 && method.Line <= line)
            .OrderByDescending(method => method.Line)
            .FirstOrDefault();

        return best ?? candidates.OrderBy(method => method.Line).First();
    }

    /// <summary>The listing of one method, or of everything a file was compiled into.</summary>
    public ViewDto Asm(NativeMethod? method, string? file)
    {
        var listing = new Listing();
        var methods = method is not null ? [method] : MethodsOfFile(file ?? string.Empty);
        var title = method is not null
            ? $"{method.FullName} — native ASM"
            : $"{System.IO.Path.GetFileName(file ?? string.Empty)} — native ASM";

        listing.Write($"; Native code of {_image.MachineName}, read from {System.IO.Path.GetFileName(Path)}");
        if (DebugFile is not null && !string.Equals(DebugFile, Path, StringComparison.Ordinal))
        {
            listing.Write($"; method names and source lines from {System.IO.Path.GetFileName(DebugFile)}");
        }

        if (Note is not null)
        {
            listing.Write($"; {Note}");
        }

        if (methods.Count == 0)
        {
            listing.Write("; Nothing to show: no method of this image was compiled from that file.");
        }

        foreach (var current in methods)
        {
            if (methods.Count > 1)
            {
                listing.Write(string.Empty);
            }

            AppendMethod(listing, current);
        }

        var notes = Note is null ? null : new[] { Note };
        return new ViewDto(title, "il-asm", listing.Text, _lines is not null && methods.Count > 0, listing.Blocks, notes);
    }

    private void AppendMethod(Listing listing, NativeMethod method)
    {
        listing.Write($"; ── {method.FullName} ({method.Size} bytes at 0x{method.Address:x})");

        var code = _image.CodeAt((ulong)method.Address, method.Size);
        if (code is null)
        {
            listing.Write("; the bytes of this method are not in the image");
            return;
        }

        var instructions = NativeDisassembler.Decode(_image.Architecture, code, (ulong)method.Address);
        if (instructions.Count == 0)
        {
            listing.Write($"; the code of this method could not be decoded as {_image.MachineName}");
            return;
        }

        var index = 0;
        while (index < instructions.Count)
        {
            var source = SourceAt(instructions[index].Address);

            // Instructions of one source line become one block, which is what the client highlights
            // when the caret moves in the original file.
            var last = index;
            while (last + 1 < instructions.Count && SameSource(source, SourceAt(instructions[last + 1].Address)))
            {
                last++;
            }

            var firstLine = listing.NextLine;
            for (var current = index; current <= last; current++)
            {
                listing.Write($"        0x{instructions[current].Address:x8}  {instructions[current].Text}");
            }

            if (source.File is not null && source.Line > 0)
            {
                listing.AddBlock(new MapBlock(0, method.Address, method.Address, firstLine, listing.NextLine - 1, source.File, source.Line, source.Line));
            }

            index = last + 1;
        }
    }

    private (string? File, int Line) SourceAt(ulong address)
    {
        if (_lines?.At(address) is not { } row || row.Line <= 0)
        {
            return (null, 0);
        }

        return (_lines!.FileOf(row.File), row.Line);
    }

    private static bool SameSource((string? File, int Line) left, (string? File, int Line) right) =>
        left.Line == right.Line
        && string.Equals(left.File ?? string.Empty, right.File ?? string.Empty, StringComparison.OrdinalIgnoreCase);

    private List<NativeMethod> ReadMethods()
    {
        var result = new List<NativeMethod>();
        var symbols = _image.Symbols().Concat(_debug?.Symbols() ?? []);

        foreach (var symbol in symbols)
        {
            if (!symbol.IsFunction || symbol.Address > int.MaxValue || !_image.HasCodeAt(symbol.Address))
            {
                continue;
            }

            var known = _names?.Find(symbol.Name);
            var mangled = Demangle(symbol.Name);
            // The debug information names the type as the mangled one, so it needs the same reading.
            var declaringType = known is { DeclaringType.Length: > 0 }
                ? TypeName(StripAssembly(known.DeclaringType))
                : mangled.Type;
            var name = known?.Name ?? mangled.Method;
            var row = _lines?.At(symbol.Address);

            result.Add(new NativeMethod(
                (int)symbol.Address,
                (int)symbol.Size,
                name,
                declaringType,
                declaringType.Length > 0 ? $"{declaringType}.{name}" : name,
                row is null ? string.Empty : _lines?.FileOf(row.File) ?? string.Empty,
                row?.Line ?? 0,
                symbol.Name,
                !symbol.Name.StartsWith(Name + "_", StringComparison.Ordinal)));
        }

        return result
            .GroupBy(method => method.Address)
            .Select(group => group.First())
            .OrderByDescending(method => SourceExists(method.File))
            .ThenBy(method => method.FullName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static bool SourceExists(string file) => file.Length > 0 && File.Exists(file);

    private static bool SameFile(string left, string right) =>
        string.Equals(left.Replace('\\', '/'), right.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Reads what the mangling of a symbol says. The compiler joins the assembly, the type and the
    /// method with underscores and turns every dot into one, so the last pair of underscores separates
    /// the type from the method and the last single underscore inside it separates the namespace from
    /// the name. Debug information is preferred over this; the mangling is the fallback for an image
    /// that carries none, where a name holding an underscore of its own can come out wrong.
    /// </summary>
    private (string Type, string Method) Demangle(string symbol)
    {
        var body = StripAssembly(symbol);
        var separator = body.LastIndexOf("__", StringComparison.Ordinal);

        return separator > 0
            ? (TypeName(body[..separator]), body[(separator + 2)..])
            : (TypeName(body), string.Empty);
    }

    /// <summary>Removes the name of the assembly the compiler puts in front of every symbol.</summary>
    private string StripAssembly(string name)
    {
        var prefix = Name + "_";
        return name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? name[prefix.Length..] : name;
    }

    /// <summary>
    /// The readable name of a type from its mangled one: the last underscore is where the namespace
    /// ends. A part on its own is the type itself, as a type in no namespace is mangled without one.
    /// </summary>
    private static string TypeName(string body)
    {
        var lastDot = body.LastIndexOf('_');
        return lastDot > 0
            ? $"{body[..lastDot].Replace('_', '.')}.{body[(lastDot + 1)..]}"
            : body.Replace('_', '.');
    }

    public void Dispose()
    {
        // The bytes of the image are held in memory and nothing else is open, so there is nothing to
        // release; the cache disposes every entry it holds and this keeps the two alike.
    }

    /// <summary>
    /// The listing being built. It counts its own lines as it writes them, because a block of the
    /// view has to say which lines of the text it covers.
    /// </summary>
    private sealed class Listing
    {
        private readonly System.Text.StringBuilder _text = new();

        public List<MapBlock> Blocks { get; } = [];

        /// <summary>The number of lines written so far, which is the line the next one lands on.</summary>
        public int NextLine => _text.ToString().Count(character => character == '\n') + 1;

        public string Text => _text.ToString();

        public void Write(string line) => _text.AppendLine(line);

        public void AddBlock(MapBlock block) => Blocks.Add(block);
    }
}
