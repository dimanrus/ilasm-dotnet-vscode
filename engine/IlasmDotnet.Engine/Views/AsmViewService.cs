using System.Diagnostics;
using System.Reflection;
using System.Reflection.Metadata;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

public sealed record AsmRequest(bool Optimized);

/// <summary>
/// Produces the native ASM view by asking the JIT itself for the disassembly.
///
/// Each method is compiled in its own child process with <c>DOTNET_JitDisasm</c> scoped to that
/// method. The JIT prints listings in its own order and can interleave them with anything else
/// written to the same stream, so attribution by stream position is not reliable; one process per
/// method keeps every listing unambiguously tied to its metadata token. Runs are bounded in
/// parallel so a whole file does not take as long as the sum of its methods.
/// </summary>
public static class AsmViewService
{
    private const string ListingPrefix = "; Assembly listing for method ";

    /// <summary>Upper bound on how many methods are compiled for one request.</summary>
    public const int MaxMethods = 60;

    private const int MaxParallelism = 4;
    private static readonly TimeSpan RunTimeout = TimeSpan.FromSeconds(60);

    public static ViewDto Build(
        AssemblyEntry entry,
        IReadOnlyList<MethodDefinitionHandle> methods,
        string title,
        AsmRequest request,
        IReadOnlyList<string>? headerNotes = null)
    {
        if (methods.Count == 0)
        {
            // A type that declares no body at all — a marker interface, an empty class — is asked for
            // its native code like any other; saying so is better than failing the read.
            return new ViewDto(
                $"{title} (ASM)",
                "il-asm",
                $"; No method body was found for {title}.\n; Native code is reported per method, so there is nothing to disassemble.\n",
                entry.Pdb is not null,
                Array.Empty<MapBlock>(),
                new[] { "Nothing here has a method body, so there is no native code to read." });
        }

        var selected = methods.Take(MaxMethods).ToList();
        var notes = new List<string>();
        if (methods.Count > selected.Count)
        {
            notes.Add($"Only the first {MaxMethods} methods of {methods.Count} were compiled.");
        }

        var results = RunAll(entry, selected, request);

        var text = new LineWriter();
        var blocks = new List<MapBlock>();

        text.AppendLine($"; Native code for {title}");
        text.AppendLine($"; Requested: {(request.Optimized ? "optimized code" : "tiered compilation")}");
        text.AppendLine($"; {selected.Count} method(s), requested {(request.Optimized ? "optimized code" : "tiered compilation")}. The method bodies are compiled, not executed.");
        text.AppendLine("; Attach to a running process to get the IL instruction behind each native instruction.");

        // Why the code in the file was not used, when it carries some that could not be read.
        foreach (var header in headerNotes ?? Array.Empty<string>())
        {
            text.AppendLine($"; {header}");
            text.AppendLine("; The listing below was compiled on this machine instead, so it is not the code the file ships.");
        }

        foreach (var (method, result) in results)
        {
            var token = AssemblyEntry.TokenOf(method);
            var signature = entry.GetMemberSignature(method);
            var startLine = text.Line;

            text.AppendLine();
            text.AppendLine($"; ── {signature}");

            var facts = new List<string>();
            if (result.CodeKind.Length > 0)
            {
                facts.Add(result.CodeKind);
            }

            if (result.CodeSize > 0)
            {
                facts.Add($"{result.CodeSize} bytes of code");
            }

            if (result.Runtime.Length > 0)
            {
                facts.Add($"runtime {result.Runtime}");
            }

            if (facts.Count > 0)
            {
                text.AppendLine($"; {string.Join(", ", facts)}");
            }

            if (result.Error is not null)
            {
                notes.Add($"{signature} — {result.Error}");
                text.AppendLine($"; no native code was produced: {result.Error}");
                blocks.Add(new MapBlock(token, 0, entry.GetMethodBodySize(token), startLine, text.Line, null, 0, 0));
                continue;
            }

            if (result.Listing.Count == 0)
            {
                notes.Add($"{signature} — the JIT did not emit a listing.");
                text.AppendLine("; the JIT did not emit a listing for this method.");
                blocks.Add(new MapBlock(token, 0, entry.GetMethodBodySize(token), startLine, text.Line, null, 0, 0));
                continue;
            }

            // A debug build carries [Debuggable], which disables optimization whatever was requested.
            if (request.Optimized && result.CodeKind.Contains("MinOpts", StringComparison.Ordinal))
            {
                notes.Add($"{signature} — the assembly disables optimization (likely a debug build with [Debuggable]).");
            }

            foreach (var line in result.Listing)
            {
                text.AppendLine(line);
            }

            blocks.Add(new MapBlock(token, 0, entry.GetMethodBodySize(token), startLine, text.Line - 1, null, 0, 0));
        }

        var distinctNotes = notes.Distinct().ToList();
        var noCode = results.Count(result => result.Result.Listing.Count == 0 || result.Result.Error is not null);
        if (noCode > 0 && results.Count > 1)
        {
            // PrepareMethod does not always force compilation (base methods on abstract types and
            // some virtual slots stay uncompiled), and the body is deliberately never invoked.
            distinctNotes.Add($"{noCode} of {results.Count} methods produced no native code because the runtime did not compile them on request.");
        }

        var viewTitle = title.EndsWith("(ASM)", StringComparison.Ordinal) ? title : title + " (ASM)";
        return new ViewDto(
            viewTitle,
            "il-asm",
            text.Text,
            entry.Pdb is not null,
            blocks,
            distinctNotes.Count == 0 ? null : distinctNotes);
    }

    /// <summary>Convenience overload for a single member.</summary>
    public static ViewDto Build(AssemblyEntry entry, EntityHandle handle, string title, AsmRequest request) =>
        Build(entry, entry.GetAccessors(handle), title, request);

    private static IReadOnlyList<(MethodDefinitionHandle Method, JitResult Result)> RunAll(
        AssemblyEntry entry,
        IReadOnlyList<MethodDefinitionHandle> methods,
        AsmRequest request)
    {
        var results = new JitResult[methods.Count];
        var options = new ParallelOptions { MaxDegreeOfParallelism = MaxParallelism };

        Parallel.For(0, methods.Count, options, index =>
        {
            var handle = methods[index];
            var typeName = entry.GetReflectionTypeName(entry.GetDeclaringTypeOfMethod(handle));
            var methodName = entry.GetClrMethodName(handle);
            results[index] = RunJit(entry, AssemblyEntry.TokenOf(handle), typeName, methodName, request);
        });

        return methods.Select((method, index) => (method, results[index])).ToList();
    }

    private sealed record JitResult(string Runtime, IReadOnlyList<string> Listing, string? Error, string CodeKind, int CodeSize);

    private static JitResult RunJit(AssemblyEntry entry, int token, string typeName, string methodName, AsmRequest request)
    {
        var (host, assembly) = ResolveSelf();
        var startInfo = new ProcessStartInfo(host)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        // The harness loads the assembly into the runtime, so it has to be given the file that holds
        // the metadata: for a single file application that is the assembly inside the bundle.
        foreach (var argument in new[] { assembly, "--jit-disasm", entry.ReadablePath, token.ToString() })
        {
            startInfo.ArgumentList.Add(argument);
        }

        startInfo.Environment["DOTNET_JitDisasm"] = $"{typeName}:{methodName}";
        startInfo.Environment["DOTNET_TieredCompilation"] = request.Optimized ? "0" : "1";
        startInfo.Environment["DOTNET_TieredPGO"] = "0";
        startInfo.Environment["DOTNET_ReadyToRun"] = "0";
        startInfo.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        startInfo.Environment["DOTNET_NOLOGO"] = "1";

        using var process = new Process { StartInfo = startInfo };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            return new JitResult(string.Empty, Array.Empty<string>(), $"could not start the JIT harness: {ex.Message}", string.Empty, 0);
        }

        var runtime = string.Empty;
        var listing = new List<string>();
        string? error = null;

        var reading = Task.Run(() =>
        {
            var inListing = false;
            string? line;
            while ((line = process.StandardOutput.ReadLine()) is not null)
            {
                if (line.StartsWith("[jit] runtime ", StringComparison.Ordinal))
                {
                    runtime = line["[jit] runtime ".Length..].Trim();
                    continue;
                }

                if (line.StartsWith("[jit] error ", StringComparison.Ordinal))
                {
                    error = line["[jit] error ".Length..].Trim();
                    continue;
                }

                if (line.StartsWith(ListingPrefix, StringComparison.Ordinal))
                {
                    inListing = true;
                }

                if (inListing)
                {
                    listing.Add(line);
                }
            }
        });

        var stderr = process.StandardError.ReadToEndAsync();

        if (!process.WaitForExit((int)RunTimeout.TotalMilliseconds))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception)
            {
                // The process exited between the timeout and the kill.
            }

            return new JitResult(runtime, Array.Empty<string>(), $"the JIT harness did not finish within {RunTimeout.TotalSeconds:0} seconds.", string.Empty, 0);
        }

        reading.Wait(TimeSpan.FromSeconds(5));

        var diagnostics = stderr.Wait(TimeSpan.FromSeconds(1)) ? stderr.Result.Trim() : string.Empty;
        if (error is null && listing.Count == 0 && diagnostics.Length > 0)
        {
            // Most often a missing dependency of the target assembly.
            error = diagnostics;
        }
        else if (error is not null && diagnostics.Length > 0)
        {
            error = $"{error} ({diagnostics})";
        }

        TrimListing(listing);
        return new JitResult(runtime, listing, error, ExtractCodeKind(listing), ExtractCodeSize(listing));
    }

    /// <summary>Code kind the JIT reported, for example FullOpts or MinOpts.</summary>
    private static string ExtractCodeKind(IReadOnlyList<string> listing)
    {
        foreach (var line in listing)
        {
            if (!line.StartsWith(ListingPrefix, StringComparison.Ordinal))
            {
                continue;
            }

            var open = line.LastIndexOf('(');
            var close = line.LastIndexOf(')');
            if (open >= 0 && close > open)
            {
                return line[(open + 1)..close];
            }

            break;
        }

        return string.Empty;
    }

    /// <summary>Native code size the JIT reported, in bytes.</summary>
    private static int ExtractCodeSize(IReadOnlyList<string> listing)
    {
        foreach (var line in listing)
        {
            const string marker = "; Total bytes of code ";
            if (line.StartsWith(marker, StringComparison.Ordinal) &&
                int.TryParse(line[marker.Length..].Trim(), out var size))
            {
                return size;
            }
        }

        return 0;
    }

    /// <summary>Drops the blank lines the JIT leaves after the last instruction block.</summary>
    private static void TrimListing(List<string> listing)
    {
        while (listing.Count > 0 && listing[^1].Trim().Length == 0)
        {
            listing.RemoveAt(listing.Count - 1);
        }
    }

    /// <summary>Locates the dotnet host and this assembly so the harness can be started.</summary>
    private static (string Host, string Assembly) ResolveSelf()
    {
        var assembly = Assembly.GetEntryAssembly()?.Location ?? Assembly.GetExecutingAssembly().Location;
        var processPath = Environment.ProcessPath;
        var host = processPath is not null &&
            Path.GetFileNameWithoutExtension(processPath).Equals("dotnet", StringComparison.OrdinalIgnoreCase)
                ? processPath
                : "dotnet";

        return (host, assembly);
    }
}
