using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text.Json;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;
using IlasmDotnet.Engine.Native;
using IlasmDotnet.Engine.Rpc;
using IlasmDotnet.Engine.Views;
using IlasmDotnet.Engine.Jit;
using IlasmDotnet.Engine.Live;
using IlasmDotnet.Engine.Views.ReadyToRun;

namespace IlasmDotnet.Engine;

internal static class Program
{
    private const int MaxOpenAssemblies = 4;

    private static readonly WorkspaceCache Cache = new(MaxOpenAssemblies);

    /// <summary>Native images are read straight from their bytes and have no handles to release.</summary>
    private static readonly NativeCache Natives = new(MaxOpenAssemblies);

    private static int Main(string[] args)
    {
        // The engine doubles as the JIT harness: the same assembly is started again with the
        // disassembly environment variables set, so no second project has to be shipped.
        if (args.Length > 0 && args[0] == "--jit-disasm")
        {
            return JitDisasmHarness.Run(args);
        }

        // The same read the native route does, as a command, for images nobody can explain yet.
        if (args.Length > 1 && args[0] == "--native")
        {
            return NativeProbe.Run(args.Skip(1).ToList());
        }

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Console.Error.WriteLine($"[engine] fatal: {e.ExceptionObject}");

        var server = new JsonRpcServer(Console.In, Console.Out);
        try
        {
            server.Run(Dispatch);
        }
        finally
        {
            Live.Detach();
            Cache.Dispose();
            Natives.Dispose();
        }

        return 0;
    }

    private static object? Dispatch(string method, JsonElement? parameters) => method switch
    {
        "ping" => "pong",
        "assembly/info" => AssemblyInfo(parameters),
        "assembly/types" => Types(parameters),
        "assembly/members" => Members(parameters),
        "view/il" => View(parameters, il: true),
        "view/csharp" => View(parameters, il: false),
        "view/asm" => AsmView(parameters),
        "view/asmLive" => LiveAsmView(parameters),
        "view/fileAsmLive" => LiveFileAsmView(parameters),
        "processes" => LiveAsmService.ListProcesses(),
        "live/attach" => LiveAttach(parameters),
        "live/detach" => LiveDetach(),
        "live/status" => Live.Status?.Describe(),
        "view/fileIl" => FileView(parameters, FileViewKind.Il),
        "view/fileCsharp" => FileView(parameters, FileViewKind.CSharp),
        "view/fileAsm" => FileView(parameters, FileViewKind.Asm),
        "assemble/roundTrip" => RoundTrip(parameters),
        "file/scope" => FileScope(parameters),
        "map/memberBySource" => MemberBySource(parameters),
        "map/fileOf" => FileOf(parameters),
        "native/info" => NativeInfo(parameters),
        "native/methods" => NativeMethods(parameters),
        "native/asm" => NativeAsm(parameters),
        "native/methodBySource" => NativeMethodBySource(parameters),
        "shutdown" => "bye",
        _ => throw new InvalidOperationException($"Unknown method '{method}'"),
    };

    private static AssemblyInfoDto AssemblyInfo(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        return entry.Describe();
    }

    /// <summary>
    /// Writes the whole assembly as ILASM, assembles it with ilasm and reports what came back. This
    /// is the check that the listing is real IL and not just something that reads well.
    /// </summary>
    private static AssembleResultDto RoundTrip(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var outputDirectory = OptionalString(parameters, "outputDirectory")
            ?? Path.Combine(Path.GetTempPath(), "ilasm-dotnet-roundtrip", Path.GetFileNameWithoutExtension(entry.Path));
        var ilasmPath = OptionalString(parameters, "ilasmPath");
        return IlAsmRoundTripService.Assemble(entry, outputDirectory, ilasmPath);
    }

    private static IReadOnlyList<TypeDto> Types(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var search = OptionalString(parameters, "search");
        var limit = OptionalInt(parameters, "limit", 4000);

        var result = new List<TypeDto>();
        foreach (var handle in entry.EnumerateTypes())
        {
            var dto = entry.DescribeType(handle);
            if (search is not null && !dto.FullName.Contains(search, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            result.Add(dto);
            if (result.Count >= limit)
            {
                break;
            }
        }

        return result;
    }

    private static IReadOnlyList<MemberDto> Members(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var handle = MetadataTokens.EntityHandle(RequiredInt(parameters, "token"));
        if (handle.Kind != HandleKind.TypeDefinition)
        {
            throw new InvalidOperationException("assembly/members expects a TypeDefinition token");
        }

        return entry.ListMembers((TypeDefinitionHandle)handle);
    }

    private static ViewDto View(JsonElement? parameters, bool il)
    {
        var path = RequiredString(parameters, "path");
        var entry = Cache.Get(path);
        var handle = MetadataTokens.EntityHandle(RequiredInt(parameters, "token"));
        var title = DescribeHandle(entry, handle);
        var includeGenerated = OptionalBool(parameters, "includeCompilerGenerated", false);
        var lowLevel = OptionalBool(parameters, "lowLevel", false);

        var view = il
            ? IlViewService.Build(entry, handle, title)
            : CSharpViewService.Build(entry, handle, title, includeGenerated, lowLevel);

        return FromBundle(entry, view);
    }

    /// <summary>
    /// Runs the native view against a running process, which is the only route that carries the JIT
    /// mapping from a native address to an IL offset.
    /// </summary>
    private static ViewDto LiveAsmView(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var handle = MetadataTokens.EntityHandle(RequiredInt(parameters, "token"));
        var session = Live.Status ?? throw new InvalidOperationException("No process is attached. Attach to a running process first.");

        var title = DescribeHandle(entry, handle);
        return handle.Kind == HandleKind.TypeDefinition
            ? new LiveAsmService(entry, session).Build(entry.GetMethodTokensInDisassemblyOrder((TypeDefinitionHandle)handle).Select(MetadataTokens.MethodDefinitionHandle).ToList(), title)
            : new LiveAsmService(entry, session).Build(handle, title);
    }

    /// <summary>Live view of every body written in a source file, disassembled from the process.</summary>
    private static ViewDto LiveFileAsmView(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var file = RequiredString(parameters, "file");
        var includeGenerated = OptionalBool(parameters, "includeCompilerGenerated", false);
        var session = Live.Status ?? throw new InvalidOperationException("No process is attached. Attach to a running process first.");

        var methods = FileScopeService.MethodHandles(Cache.GetSourceIndex(entry), file, includeGenerated);
        if (methods.Count == 0)
        {
            throw new InvalidOperationException($"No method body in {Path.GetFileName(file)} was found.");
        }

        return new LiveAsmService(entry, session).Build(methods, Path.GetFileName(file));
    }

    private static LiveAttachResult LiveAttach(JsonElement? parameters)
    {
        var pid = RequiredInt(parameters, "pid");
        var mode = OptionalString(parameters, "mode") == "attach" ? LiveMode.Attach : LiveMode.Snapshot;

        Live.Detach();
        Live.Status = LiveSession.Open(pid, mode, Path.GetTempPath());
        return Live.Status.Describe();
    }

    private static string LiveDetach()
    {
        Live.Detach();
        return "detached";
    }

    private static ViewDto AsmView(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var handle = MetadataTokens.EntityHandle(RequiredInt(parameters, "token"));
        var optimized = OptionalBool(parameters, "optimized", true);
        var title = DescribeHandle(entry, handle);

        return FromBundle(entry, Asm(entry, MethodsOf(entry, handle), title, Source(parameters), optimized));
    }

    /// <summary>
    /// Adds the note that says where an assembly of a single file application was read from. Nobody
    /// opened a dll, so a reader who wonders which file the listing describes deserves to be told.
    /// </summary>
    private static ViewDto FromBundle(AssemblyEntry entry, ViewDto view)
    {
        if (entry.BundleDirectory is null)
        {
            return view;
        }

        var note = $"The assembly was taken out of the single file application {Path.GetFileName(entry.Path)}.";
        var notes = view.Notes is null ? new List<string>() : [.. view.Notes];
        notes.Add(note);

        return view with { Notes = notes };
    }

    /// <summary>
    /// Method bodies a token stands for: a member is one body, an accessor is the body of the property
    /// or event it belongs to, and a type is every body it declares, nested types included. Native code
    /// is reported per method, so a type is the widest thing that can be disassembled at once.
    /// </summary>
    private static IReadOnlyList<MethodDefinitionHandle> MethodsOf(AssemblyEntry entry, EntityHandle handle) =>
        handle.Kind == HandleKind.TypeDefinition
            ? entry.GetMethodTokensInDisassemblyOrder((TypeDefinitionHandle)handle)
                .Select(MetadataTokens.MethodDefinitionHandle)
                .ToList()
            : entry.GetAccessors(handle);

    /// <summary>
    /// Native code of the given methods: read from the image when it carries precompiled code, and
    /// compiled on this machine otherwise. A file whose own code could not be read says so in the
    /// listing, so a fallback never looks like the code the application runs.
    /// </summary>
    private static ViewDto Asm(
        AssemblyEntry entry,
        IReadOnlyList<MethodDefinitionHandle> methods,
        string title,
        string source,
        bool optimized)
    {
        var request = new AsmRequest(optimized);
        if (source == "jit" || methods.Count == 0)
        {
            return AsmViewService.Build(entry, methods, title, request);
        }

        var image = ReadyToRunAsmService.Build(entry, methods, title);
        if (image.View is not null)
        {
            return image.View;
        }

        if (source == "image")
        {
            throw new InvalidOperationException(
                image.Note ?? $"{Path.GetFileName(entry.Path)} is not a ReadyToRun image for a supported architecture, so it holds no precompiled code to read.");
        }

        return image.Note is null
            ? AsmViewService.Build(entry, methods, title, request)
            : AsmViewService.Build(entry, methods, title, request, new[] { image.Note });
    }

    private static string Source(JsonElement? parameters) => OptionalString(parameters, "source") ?? "auto";

    private static FileScopeDto FileScope(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var file = RequiredString(parameters, "file");
        var includeGenerated = OptionalBool(parameters, "includeCompilerGenerated", false);
        return FileScopeService.Describe(entry, Cache.GetSourceIndex(entry), file, includeGenerated);
    }

    private enum FileViewKind
    {
        Il,
        CSharp,
        Asm,
    }

    /// <summary>Whole-file views: every body the portable PDB attributes to the given source file.</summary>
    private static ViewDto FileView(JsonElement? parameters, FileViewKind kind)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        return FromBundle(entry, FileViewOf(parameters, kind, entry));
    }

    private static ViewDto FileViewOf(JsonElement? parameters, FileViewKind kind, AssemblyEntry entry)
    {
        var file = RequiredString(parameters, "file");
        var index = Cache.GetSourceIndex(entry);
        var includeGenerated = OptionalBool(parameters, "includeCompilerGenerated", false);
        var fileName = Path.GetFileName(file);

        if (!index.HasEntries)
        {
            return new ViewDto(
                $"{fileName} — {kind}",
                kind == FileViewKind.Asm ? "il-asm" : kind == FileViewKind.Il ? "il" : "csharp",
                $"; No debug information is available for {fileName}.\n; Build the project with a portable PDB to see file scoped views.\n",
                false,
                Array.Empty<MapBlock>(),
                new[] { "The assembly has no portable PDB, so the file could not be mapped to types." });
        }

        switch (kind)
        {
            case FileViewKind.Il:
            {
                var (types, generatedOnly) = FileTypes(entry, index, file, includeGenerated);
                return FileScopeService.BuildIl(entry, types, file, generatedOnly);
            }

            case FileViewKind.CSharp:
            {
                var lowLevel = OptionalBool(parameters, "lowLevel", false);
                // Generated types are the point of a low-level view, so they are always included there.
                var (types, generatedOnly) = FileTypes(entry, index, file, includeGenerated || lowLevel);
                return FileScopeService.BuildCSharp(entry, types, file, includeGenerated || generatedOnly, lowLevel, generatedOnly);
            }

            default:
            {
                var methods = FileScopeService.MethodHandles(index, file, includeGenerated);
                if (methods.Count == 0)
                {
                    return new ViewDto(
                        $"{fileName} — ASM",
                        "il-asm",
                        $"; No method body in {fileName} has debug information.\n",
                        false,
                        Array.Empty<MapBlock>(),
                        new[] { "Nothing in this file could be mapped to a method body." });
                }

                var optimized = OptionalBool(parameters, "optimized", true);
                return Asm(entry, methods, fileName, Source(parameters), optimized);
            }
        }
    }

    /// <summary>
    /// Source a token came from. The tree hands over tokens, while a click there has to open a file
    /// and put the caret on the right line, so both are what this turns a token into.
    /// </summary>
    private static FileOfDto FileOf(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var token = RequiredInt(parameters, "token");
        var source = Cache.GetSourceIndex(entry).SourceOf(token);
        return new FileOfDto(source?.File, source?.Line ?? 0);
    }

    /// <summary>What a native image is: a stripped NativeAOT binary, or an ordinary native library.</summary>
    private static NativeInfoDto NativeInfo(JsonElement? parameters)
    {
        var entry = Natives.Get(RequiredString(parameters, "path"));
        return new NativeInfoDto(
            entry.Path,
            entry.Name,
            entry.MachineName,
            entry.DebugFile is not null,
            entry.DebugFile,
            entry.MethodCount,
            entry.Methods.Count(method => method.IsRuntime),
            entry.Note);
    }

    /// <summary>
    /// The methods of a native image, or the ones compiled from one file. The methods of the runtime
    /// the image was built with are left out unless they are asked for: a read of `nm` output is not
    /// what someone opening their own program wants. An image whose name matches none of its symbols
    /// would come out empty that way, so then everything is returned instead.
    /// </summary>
    private static IReadOnlyList<NativeMethodDto> NativeMethods(JsonElement? parameters)
    {
        var entry = Natives.Get(RequiredString(parameters, "path"));
        var file = OptionalString(parameters, "file");
        var includeRuntime = OptionalBool(parameters, "includeRuntime", false);

        var methods = file is null ? entry.Methods : entry.MethodsOfFile(file);
        if (!includeRuntime)
        {
            var own = methods.Where(method => !method.IsRuntime).ToList();
            methods = own.Count > 0 ? own : methods;
        }

        return methods.Select(ToDto).ToList();
    }

    /// <summary>The machine code of one method or of every method a file was compiled into.</summary>
    private static ViewDto NativeAsm(JsonElement? parameters)
    {
        var entry = Natives.Get(RequiredString(parameters, "path"));
        var address = OptionalInt(parameters, "address", 0);
        var file = OptionalString(parameters, "file");

        NativeMethod? method = null;
        if (address != 0)
        {
            method = entry.MethodAt(address)
                ?? throw new InvalidOperationException($"No method of {entry.Name} starts at 0x{address:x}.");
        }

        return entry.Asm(method, file);
    }

    /// <summary>The method a line of source belongs to, which is what a caret in a .cs file resolves to.</summary>
    private static NativeMethodDto? NativeMethodBySource(JsonElement? parameters)
    {
        var entry = Natives.Get(RequiredString(parameters, "path"));
        var method = entry.MethodBySource(RequiredString(parameters, "file"), RequiredInt(parameters, "line"));
        return method is null ? null : ToDto(method);
    }

    private static NativeMethodDto ToDto(NativeMethod method) => new(
        method.Address,
        method.Size,
        method.Name,
        method.FullName,
        method.DeclaringType,
        method.File,
        method.Line,
        method.Symbol,
        method.IsRuntime);

    /// <summary>
    /// Types of the members written in a file. With the visible ones empty, the file's bodies are all
    /// inside types the compiler generated — a file of nothing but an async entry point looks like
    /// that — so those types are used instead: showing an empty view would hide code that is right
    /// there, and the caller says in the listing why they are listed.
    /// </summary>
    private static (IReadOnlyList<int> Types, bool GeneratedOnly) FileTypes(
        AssemblyEntry entry,
        SourceIndex index,
        string file,
        bool includeGenerated)
    {
        var types = FileScopeService.TypeTokens(index, file, includeGenerated);
        if (types.Count > 0)
        {
            return (types, false);
        }

        // The types are the ones that declare the generated code, not the generated types themselves:
        // a view of the declaring type is where the async or iterator method is rebuilt from its state
        // machine, which is the code the file was written as.
        var declaring = FileScopeService.TypeTokens(index, file, true)
            .SelectMany(token => entry.EnclosingTypes(MetadataTokens.TypeDefinitionHandle(token)).Skip(1))
            .Select(handle => MetadataTokens.GetToken(handle))
            .Distinct()
            .ToList();

        return (declaring.Count > 0 ? declaring : FileScopeService.TypeTokens(index, file, true), true);
    }

    private static MemberLocationDto? MemberBySource(JsonElement? parameters)
    {
        var entry = Cache.Get(RequiredString(parameters, "path"));
        var file = RequiredString(parameters, "file");
        var line = RequiredInt(parameters, "line");
        return Cache.GetSourceIndex(entry).Find(file, line);
    }

    private static string DescribeHandle(AssemblyEntry entry, EntityHandle handle)
    {
        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
                return entry.GetFullName((TypeDefinitionHandle)handle);
            case HandleKind.MethodDefinition:
                var method = entry.Metadata.GetMethodDefinition((MethodDefinitionHandle)handle);
                return entry.GetFullName(method.GetDeclaringType()) + "." + entry.Metadata.GetString(method.Name);
            case HandleKind.FieldDefinition:
                var field = entry.Metadata.GetFieldDefinition((FieldDefinitionHandle)handle);
                return entry.GetFullName(field.GetDeclaringType()) + "." + entry.Metadata.GetString(field.Name);
            case HandleKind.PropertyDefinition:
                var property = entry.Metadata.GetPropertyDefinition((PropertyDefinitionHandle)handle);
                return entry.GetFullName(entry.FindDeclaringType(handle)) + "." + entry.Metadata.GetString(property.Name);
            case HandleKind.EventDefinition:
                var @event = entry.Metadata.GetEventDefinition((EventDefinitionHandle)handle);
                return entry.GetFullName(entry.FindDeclaringType(handle)) + "." + entry.Metadata.GetString(@event.Name);
            default:
                return handle.Kind.ToString();
        }
    }

    private static string RequiredString(JsonElement? parameters, string name)
    {
        if (parameters is null || !parameters.Value.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidOperationException($"Missing string parameter '{name}'");
        }

        return value.GetString()!;
    }

    private static string? OptionalString(JsonElement? parameters, string name)
    {
        if (parameters is null || !parameters.Value.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return value.GetString();
    }

    private static int RequiredInt(JsonElement? parameters, string name)
    {
        if (parameters is null || !parameters.Value.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number)
        {
            throw new InvalidOperationException($"Missing number parameter '{name}'");
        }

        return value.GetInt32();
    }

    private static int OptionalInt(JsonElement? parameters, string name, int fallback)
    {
        if (parameters is null || !parameters.Value.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number)
        {
            return fallback;
        }

        return value.GetInt32();
    }

    private static bool OptionalBool(JsonElement? parameters, string name, bool fallback)
    {
        if (parameters is null || !parameters.Value.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)
        {
            return fallback;
        }

        return value.GetBoolean();
    }

    /// <summary>The single process session the user is inspecting, if any.</summary>
    private static class Live
    {
        public static LiveSession? Status { get; set; }

        public static void Detach()
        {
            Status?.Dispose();
            Status = null;
        }
    }

    /// <summary>
    /// Keeps a small LRU cache of native images. An image is read again when either the image or the
    /// debug file beside it changed, because a publish rewrites both.
    /// </summary>
    private sealed class NativeCache : IDisposable
    {
        private readonly int _capacity;
        private readonly Dictionary<string, NativeImageEntry> _entries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _stamps = new(StringComparer.Ordinal);
        private readonly List<string> _order = new();

        public NativeCache(int capacity) => _capacity = capacity;

        public NativeImageEntry Get(string path)
        {
            var full = Path.GetFullPath(path);
            var stamp = StampOf(full);

            if (_entries.TryGetValue(full, out var entry) && _stamps.TryGetValue(full, out var known) && known == stamp)
            {
                Touch(full);
                return entry;
            }

            entry = NativeImageEntry.Open(full);
            _entries[full] = entry;
            _stamps[full] = stamp;
            Touch(full);
            return entry;
        }

        /// <summary>Size and write time of the image and of the debug file beside it.</summary>
        private static long StampOf(string path)
        {
            var info = new FileInfo(path);
            var stamp = info.Exists ? info.LastWriteTimeUtc.Ticks ^ info.Length : 0;

            var debug = NativeDebugFile.Find(path);
            if (debug is not null && !string.Equals(debug, path, StringComparison.Ordinal))
            {
                var debugInfo = new FileInfo(debug);
                stamp ^= debugInfo.Exists ? debugInfo.LastWriteTimeUtc.Ticks ^ debugInfo.Length : 0;
            }

            return stamp;
        }

        private void Touch(string path)
        {
            _order.Remove(path);
            _order.Add(path);

            while (_order.Count > _capacity)
            {
                var oldest = _order[0];
                _order.RemoveAt(0);
                _stamps.Remove(oldest);
                if (_entries.Remove(oldest, out var evicted))
                {
                    evicted.Dispose();
                }
            }
        }

        public void Dispose()
        {
            foreach (var entry in _entries.Values)
            {
                entry.Dispose();
            }

            _entries.Clear();
            _stamps.Clear();
            _order.Clear();
        }
    }

    /// <summary>Keeps a small LRU cache of opened assemblies and their source indexes.</summary>
    private sealed class WorkspaceCache : IDisposable
    {
        private readonly int _capacity;
        private readonly Dictionary<string, AssemblyEntry> _entries = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _stamps = new(StringComparer.Ordinal);
        private readonly Dictionary<string, SourceIndex> _indexes = new(StringComparer.Ordinal);
        private readonly List<string> _order = new();

        public WorkspaceCache(int capacity) => _capacity = capacity;

        public AssemblyEntry Get(string path)
        {
            var full = Path.GetFullPath(path);
            var stamp = StampOf(full);

            // A rebuild writes to the same path, so the stamp of the file decides whether the cached
            // entry still is the file on disk: without it a pane would keep showing the old build.
            if (_entries.TryGetValue(full, out var entry) && _stamps.TryGetValue(full, out var known) && known == stamp)
            {
                Touch(full);
                return entry;
            }

            if (_entries.Remove(full, out var stale))
            {
                stale.Dispose();
            }

            entry = new AssemblyEntry(full);
            _entries[full] = entry;
            _stamps[full] = stamp;
            _indexes.Remove(full);

            Touch(full);
            return entry;
        }

        /// <summary>Size and write time of the file, which change together when it is rebuilt.</summary>
        private static long StampOf(string path)
        {
            var info = new FileInfo(path);
            return info.Exists ? info.LastWriteTimeUtc.Ticks ^ info.Length : 0;
        }

        public SourceIndex GetSourceIndex(AssemblyEntry entry)
        {
            if (!_indexes.TryGetValue(entry.Path, out var index))
            {
                index = new SourceIndex(entry);
                _indexes[entry.Path] = index;
            }

            return index;
        }

        private void Touch(string path)
        {
            _order.Remove(path);
            _order.Add(path);

            while (_order.Count > _capacity)
            {
                var oldest = _order[0];
                _order.RemoveAt(0);
                _indexes.Remove(oldest);
                _stamps.Remove(oldest);
                if (_entries.Remove(oldest, out var evicted))
                {
                    evicted.Dispose();
                }
            }
        }

        public void Dispose()
        {
            foreach (var entry in _entries.Values)
            {
                entry.Dispose();
            }

            _entries.Clear();
            _indexes.Clear();
            _order.Clear();
        }
    }
}
