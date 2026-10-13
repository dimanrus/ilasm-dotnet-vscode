using System.Reflection.Metadata;
using System.Text;
using Iced.Intel;
using Microsoft.Diagnostics.Runtime;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;
using IlasmDotnet.Engine.Views;

namespace IlasmDotnet.Engine.Live;

/// <summary>A .NET process that can be inspected, as offered to the user.</summary>
public sealed record ProcessDto(int Pid, string Name, string Path, string Command);

/// <summary>
/// Turns the native code of a method in a running process into an annotated listing.
///
/// This is the only route that yields the JIT mapping from a native address to an IL offset, so it is
/// what makes it possible to link one assembly instruction to the IL instruction and the source line
/// it came from. It also works for methods the environment variable route cannot compile, such as a
/// base virtual that is never called.
/// </summary>
public sealed class LiveAsmService
{
    /// <summary>JIT maps that are not a real IL offset, as reported by the runtime.</summary>
    private const int PrologSentinel = -2;
    private const int EpilogSentinel = -3;

    private readonly AssemblyEntry _entry;
    private readonly LiveSession _session;

    public LiveAsmService(AssemblyEntry entry, LiveSession session)
    {
        _entry = entry;
        _session = session;
    }

    public static IReadOnlyList<ProcessDto> ListProcesses()
    {
        var result = new List<ProcessDto>();

        foreach (var pid in Microsoft.Diagnostics.NETCore.Client.DiagnosticsClient.GetPublishedProcesses())
        {
            string name;
            try
            {
                using var process = System.Diagnostics.Process.GetProcessById(pid);
                name = process.ProcessName;
            }
            catch (ArgumentException)
            {
                continue;
            }

            result.Add(new ProcessDto(pid, name, ExecutablePath(pid), CommandLine(pid)));
        }

        return result.OrderBy(process => process.Name, StringComparer.OrdinalIgnoreCase).ThenBy(process => process.Pid).ToList();
    }

    private static string ExecutablePath(int pid)
    {
        try
        {
            var link = new FileInfo($"/proc/{pid}/exe");
            return link.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? string.Empty;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static string CommandLine(int pid)
    {
        try
        {
            var raw = File.ReadAllText($"/proc/{pid}/cmdline");
            return raw.Replace('\0', ' ').Trim();
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    public ViewDto Build(EntityHandle handle, string title) => Build(_entry.GetAccessors(handle), title);

    public ViewDto Build(IReadOnlyList<MethodDefinitionHandle> methodHandles, string title)
    {
        if (methodHandles.Count == 0)
        {
            // Nothing to read is an answer of its own: a type without bodies, or a member that carries
            // none. Failing the request would leave whatever the tab showed before on screen.
            return new ViewDto(
                $"{title} (ASM, live)",
                "il-asm",
                $"; No method body was found for {title}, so there is no live code to read.\n",
                _entry.Pdb is not null,
                Array.Empty<MapBlock>(),
                new[] { "Nothing here has a method body, so there is no native code to read." });
        }

        var text = new LineWriter();
        var blocks = new List<MapBlock>();
        var notes = new List<string>();

        text.AppendLine($"; Native code of {title}");
        text.AppendLine($"; from process {_session.Pid} ({_session.Detail}), {_session.Mode.ToString().ToLowerInvariant()} mode");
        text.AppendLine("; Each instruction is followed by the IL instruction it implements.");

        var module = _session.FindModule(_entry.Path);
        if (module is null)
        {
            notes.Add($"Assembly {Path.GetFileName(_entry.Path)} is not loaded in process {_session.Pid}.");
            text.AppendLine($"; {notes[0]}");
            return new ViewDto(title + " (ASM, live)", "il-asm", text.Text, _entry.Pdb is not null, blocks, notes);
        }

        foreach (var methodHandle in methodHandles)
        {
            var token = AssemblyEntry.TokenOf(methodHandle);
            var signature = _entry.GetMemberSignature(methodHandle);
            text.AppendLine();
            text.AppendLine($"; ── {signature}");

            var method = FindMethod(module, methodHandle, token);
            if (method is null)
            {
                notes.Add($"{signature} — the method is not present in the loaded module.");
                text.AppendLine("; the loaded module does not contain this method.");
                continue;
            }

            var startLine = text.Line;
            AppendMethod(text, blocks, notes, method, token, signature);
            text.AppendLine();

            blocks.Add(new MapBlock(token, 0, _entry.GetMethodBodySize(token), startLine, text.Line - 1, null, 0, 0));
        }

        var distinct = notes.Distinct().ToList();
        return new ViewDto(
            title + " (ASM, live)",
            "il-asm",
            text.Text,
            _entry.Pdb is not null,
            blocks,
            distinct.Count == 0 ? null : distinct);
    }

    /// <summary>
    /// Matches the metadata token against the loaded methods. The runtime reports the token of the
    /// generic definition for generic types, which is why a name fallback is kept.
    /// </summary>
    private ClrMethod? FindMethod(ClrModule module, MethodDefinitionHandle handle, int token)
    {
        var typeName = _entry.GetReflectionTypeName(_entry.GetDeclaringTypeOfMethod(handle));
        var methodName = _entry.GetClrMethodName(handle);

        var type = FindType(module, typeName, _entry.GetDeclaringTypeOfMethod(handle));
        if (type is null)
        {
            return null;
        }

        return type.Methods.FirstOrDefault(method => method.MetadataToken == token)
            ?? type.Methods.FirstOrDefault(method => method.Name == methodName);
    }

    /// <summary>
    /// Finds a loaded type by name, falling back to the type definition token. The token route also
    /// covers generic types, which the runtime does not always expose under their source name.
    /// </summary>
    private ClrType? FindType(ClrModule module, string typeName, TypeDefinitionHandle typeHandle)
    {
        var direct = module.GetTypeByName(typeName);
        if (direct is not null)
        {
            return direct;
        }

        var wanted = AssemblyEntry.TokenOf(typeHandle);
        foreach (var (methodTable, token) in module.EnumerateTypeDefToMethodTableMap())
        {
            if (token == wanted)
            {
                return _session.Runtime.GetTypeByMethodTable(methodTable);
            }
        }

        return null;
    }

    private void AppendMethod(LineWriter text, List<MapBlock> blocks, List<string> notes, ClrMethod method, int token, string signature)
    {
        var regions = method.HotColdInfo;
        var codeSize = (int)(regions.HotSize + regions.ColdSize);

        // ReadyToRun code is compiled ahead of time, but the runtime still reports the map from a
        // native address to an IL offset for it, so the exact link works there as well.
        var precompiled = method.CompilationType == MethodCompilationType.Ngen;

        if ((!precompiled && method.CompilationType != MethodCompilationType.Jit) || codeSize == 0)
        {
            notes.Add($"{signature} — {method.CompilationType switch
            {
                MethodCompilationType.None => "the method has not been compiled yet; call it first",
                _ => "no native code was found for the method",
            }}.");
            text.AppendLine($"; {notes[^1]}");
            return;
        }

        var kind = precompiled ? "ReadyToRun" : method.CompilationType.ToString();
        text.AppendLine($"; {kind}, {codeSize} bytes of native code, {method.ILOffsetMap.Length} IL mappings");

        if (method.ILOffsetMap.Length == 0)
        {
            notes.Add($"{signature} — the runtime reported no mapping from native code to IL.");
        }

        var bytes = ReadCode(method, regions);
        if (bytes.Length == 0)
        {
            notes.Add($"{signature} — the native code could not be read from the process.");
            text.AppendLine("; the native code could not be read.");
            return;
        }

        var decoder = Iced.Intel.Decoder.Create(64, new ByteArrayCodeReader(bytes));
        decoder.IP = regions.HotStart;

        var formatter = new IntelFormatter();
        var output = new StringOutput();

        while (decoder.IP < regions.HotStart + regions.HotSize)
        {
            var instruction = decoder.Decode();
            if (instruction.IsInvalid)
            {
                break;
            }

            output.Reset();
            formatter.Format(instruction, output);

            var ilOffset = IlOffsetAt(method, instruction.IP);
            var annotation = ilOffset switch
            {
                PrologSentinel => "prolog",
                EpilogSentinel => "epilog",
                < 0 => "no IL",
                _ => $"IL_{ilOffset:x4}",
            };

            var line = $"        {output.ToString(),-46} ; {annotation}";

            // The IL pane lists one block per instruction, keyed by its IL offset, so the annotation
            // is all that is needed to link an assembly instruction to it.
            if (ilOffset >= 0)
            {
                var source = IlViewService.ResolveSource(_entry, token, ilOffset);
                blocks.Add(new MapBlock(
                    token,
                    ilOffset,
                    ilOffset + 1,
                    text.Line,
                    text.Line,
                    source.File,
                    source.StartLine,
                    source.EndLine));
            }

            text.AppendLine(line);
        }
    }

    /// <summary>
    /// The IL instruction the code at an address implements. The map of a method is a list of places
    /// where the code starts standing for another instruction, so the last place that begins at or
    /// before the address is the one that holds: the runtime reads its own table the same way, and the
    /// listing of an image is built the same way, which is what makes the two agree instruction for
    /// instruction. The lookup of the library takes the place that ends at the address instead, which
    /// labels an instruction that begins exactly where one IL instruction ends with the one before it.
    /// </summary>
    private static int IlOffsetAt(ClrMethod method, ulong address)
    {
        var map = method.ILOffsetMap;
        var result = -1;
        foreach (var place in map)
        {
            if (place.StartAddress > address)
            {
                break;
            }

            result = place.ILOffset;
        }

        return result;
    }

    private byte[] ReadCode(ClrMethod method, HotColdRegions regions)
    {
        var reader = _session.Runtime.DataTarget.DataReader as IMemoryReader;
        if (reader is null)
        {
            return Array.Empty<byte>();
        }

        var total = (int)(regions.HotSize + regions.ColdSize);
        var result = new byte[total];

        if (regions.HotSize > 0 && reader.Read(regions.HotStart, result.AsSpan(0, (int)regions.HotSize)) <= 0)
        {
            return Array.Empty<byte>();
        }

        if (regions.ColdSize > 0)
        {
            reader.Read(regions.ColdStart, result.AsSpan((int)regions.HotSize, (int)regions.ColdSize));
        }

        return result;
    }
}
