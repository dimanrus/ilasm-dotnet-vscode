using System.Diagnostics;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Disassembler;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>What came out of assembling the generated IL back into an assembly.</summary>
public sealed record AssembleResultDto(
    bool Success,
    string IlPath,
    string OutputPath,
    string IlasmPath,
    string Output,
    int OriginalTypes,
    int RoundTripTypes,
    int OriginalMethods,
    int RoundTripMethods,
    IReadOnlyList<string> Differences);

/// <summary>
/// Writes the whole assembly as one ILASM source and gives it to ilasm, so the listing the viewer
/// shows can be checked against a real assembler instead of being taken on trust.
///
/// The listing comes from the same disassembler as the viewer, but the assembler is the honest
/// arbiter: whatever ICSharpCode.Decompiler gets wrong shows up as an ilasm error.
/// </summary>
public static partial class IlAsmRoundTripService
{
    private static readonly string[] KnownRids = ["linux-x64", "linux-arm64", "osx-x64", "osx-arm64", "win-x64"];

    /// <summary>
    /// An exception handler as the disassembler writes it: both ranges abbreviated with a dash and the
    /// clause in between, for example <c>.try IL_000f-IL_002f finally IL_002f-IL_0039</c>.
    /// </summary>
    [GeneratedRegex(@"^(?<indent>\s*)\.try\s+IL_(?<tryStart>[0-9a-fA-F]+)-IL_(?<tryEnd>[0-9a-fA-F]+)\s+(?<clause>.+?)\s+IL_(?<handlerStart>[0-9a-fA-F]+)-IL_(?<handlerEnd>[0-9a-fA-F]+)\s*$", RegexOptions.Multiline)]
    private static partial Regex ExceptionHandlerRegex();

    /// <summary>
    /// Rewrites the exception handlers of a listing into the form an assembler accepts.
    ///
    /// The disassembler abbreviates a handler as ranges with a dash — <c>.try IL_000f-IL_002f finally
    /// IL_002f-IL_0039</c> — while ilasm expects the ranges spelled out with a handler clause, for
    /// example <c>.try IL_000f to IL_002f finally handler IL_002f to IL_0039</c>. Both spellings were
    /// checked against ilasm for finally, fault, catch and filter.
    /// </summary>
    public static string FixExceptionHandlers(string listing) =>
        ExceptionHandlerRegex().Replace(listing, match =>
        {
            var clause = match.Groups["clause"].Value.TrimEnd();
            if (!clause.EndsWith("handler", StringComparison.Ordinal))
            {
                clause += " handler";
            }

            return $"{match.Groups["indent"].Value}.try IL_{match.Groups["tryStart"].Value} to IL_{match.Groups["tryEnd"].Value} " +
                $"{clause} IL_{match.Groups["handlerStart"].Value} to IL_{match.Groups["handlerEnd"].Value}";
        });

    /// <summary>Renders the entire assembly, manifest included, as one ILASM source file.</summary>
    public static string WriteListing(AssemblyEntry entry)
    {
        var writer = new StringWriter();
        var output = new PlainTextOutput(writer) { IndentationString = "    " };
        var disassembler = new ReflectionDisassembler(output, CancellationToken.None)
        {
            DetectControlStructure = false,
            ShowSequencePoints = false,
            ShowMetadataTokens = false,
            ShowRawRVAOffsetAndBytes = false,
            DecodeCustomAttributeBlobs = false,
        };

        // Order matters: the references and the manifest come before the module, and ilasm wants the
        // module header before any type.
        disassembler.WriteAssemblyReferences(entry.Metadata);
        disassembler.WriteAssemblyHeader(entry.PE);
        disassembler.WriteModuleHeader(entry.PE);
        disassembler.WriteModuleContents(entry.PE);
        return FixExceptionHandlers(writer.ToString());
    }

    public static AssembleResultDto Assemble(AssemblyEntry entry, string outputDirectory, string? ilasmPath)
    {
        Directory.CreateDirectory(outputDirectory);
        var name = Path.GetFileNameWithoutExtension(entry.Path);
        var ilPath = Path.Combine(outputDirectory, name + ".il");
        var outputPath = Path.Combine(outputDirectory, name + ".roundtrip.dll");

        File.WriteAllText(ilPath, WriteListing(entry));

        var resolved = ResolveIlasm(ilasmPath);
        if (resolved is null)
        {
            return new AssembleResultDto(
                false, ilPath, outputPath, string.Empty,
                "ilasm was not found. Set \"ilasmDotnet.ilasmPath\", or install the runtime.<rid>.Microsoft.NETCore.ILAsm package " +
                "for your platform.\nThe ilasm from mono is not enough: it does not accept the listing for interfaces.",
                0, 0, 0, 0, []);
        }

        var (exitCode, output) = Run(resolved, ilPath, outputPath);
        if (exitCode != 0 || !File.Exists(outputPath))
        {
            return new AssembleResultDto(false, ilPath, outputPath, resolved, output.Trim(), 0, 0, 0, 0, []);
        }

        var (types, methods) = Describe(entry);
        var (roundTripTypes, roundTripMethods) = Describe(outputPath);
        return new AssembleResultDto(
            true, ilPath, outputPath, resolved, Summarize(output), types.Count, roundTripTypes.Count,
            methods.Count, roundTripMethods.Count, Compare(types, methods, roundTripTypes, roundTripMethods));
    }

    /// <summary>
    /// Finds an assembler. The one that ships with the extension comes first, then a path the user
    /// configured, then whatever the machine happens to have: the modern ilasm understands the
    /// listing, the mono one does not, which is why it is the last resort.
    /// </summary>
    public static string? ResolveIlasm(string? configured)
    {
        var candidates = new List<string>();

        if (!string.IsNullOrWhiteSpace(configured))
        {
            candidates.Add(configured);
        }

        var rid = RuntimeInformation.RuntimeIdentifier;
        var executable = OperatingSystem.IsWindows() ? "ilasm.exe" : "ilasm";
        var baseDirectory = AppContext.BaseDirectory;
        foreach (var candidateRid in new[] { rid }.Concat(KnownRids))
        {
            candidates.Add(Path.Combine(baseDirectory, "ilasm", candidateRid, executable));
        }

        candidates.Add(Path.Combine(baseDirectory, executable));
        candidates.AddRange(FromNuGetCache(executable));

        return candidates.FirstOrDefault(File.Exists);
    }

    /// <summary>The package cache, so a machine that restored the runtime pack needs no configuration.</summary>
    private static IEnumerable<string> FromNuGetCache(string executable)
    {
        var root = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");

        foreach (var rid in new[] { RuntimeInformation.RuntimeIdentifier }.Concat(KnownRids))
        {
            var package = Path.Combine(root, $"runtime.{rid.ToLowerInvariant()}.microsoft.netcore.ilasm");
            if (!Directory.Exists(package))
            {
                continue;
            }

            foreach (var version in Directory.EnumerateDirectories(package).OrderDescending())
            {
                yield return Path.Combine(version, "runtimes", rid, "native", executable);
            }
        }
    }

    private static (int ExitCode, string Output) Run(string ilasm, string ilPath, string outputPath)
    {
        try
        {
            File.Delete(outputPath);
        }
        catch (IOException)
        {
            // Assembling over the previous result is fine.
        }

        var start = new ProcessStartInfo(ilasm)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(ilPath) ?? ".",
        };

        start.ArgumentList.Add("-dll");
        start.ArgumentList.Add("-nologo");
        start.ArgumentList.Add($"-output={outputPath}");
        start.ArgumentList.Add(ilPath);

        using var process = Process.Start(start);
        if (process is null)
        {
            return (-1, $"ilasm could not be started: {ilasm}");
        }

        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdout + stderr);
    }

    private static string Summarize(string output)
    {
        var lines = output
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0 && !line.StartsWith("Source file is", StringComparison.Ordinal))
            .ToList();

        return lines.Count <= 12 ? string.Join('\n', lines) : string.Join('\n', lines.TakeLast(12));
    }

    /// <summary>Types and methods of an assembly, by name, for a comparison of the two round-trip ends.</summary>
    private static (List<string> Types, List<string> Methods) Describe(AssemblyEntry entry)
        => Describe(entry.Path);

    private static (List<string> Types, List<string> Methods) Describe(string path)
    {
        using var entry = new AssemblyEntry(path);
        var types = new List<string>();
        var methods = new List<string>();

        foreach (var handle in entry.EnumerateTypes())
        {
            var fullName = entry.GetFullName(handle);
            if (fullName == "<Module>")
            {
                continue;
            }

            types.Add(fullName);
            methods.AddRange(entry.ListMembers(handle)
                .Where(member => member.Kind is "method" or "constructor")
                .Select(member => $"{fullName}.{member.Signature}"));
        }

        return (types, methods);
    }

    private static List<string> Compare(
        List<string> types,
        List<string> methods,
        List<string> roundTripTypes,
        List<string> roundTripMethods)
    {
        var differences = new List<string>();
        AddMissing("type", types, roundTripTypes, differences);
        AddMissing("method", methods, roundTripMethods, differences);
        return differences;
    }

    private static void AddMissing(string kind, List<string> original, List<string> roundTrip, List<string> differences)
    {
        var missing = original.Except(roundTrip).ToList();
        var added = roundTrip.Except(original).ToList();

        if (missing.Count > 0)
        {
            differences.Add($"{missing.Count} {kind}(s) are missing from the assembled assembly: {string.Join(", ", missing.Take(5))}");
        }

        if (added.Count > 0)
        {
            differences.Add($"{added.Count} unexpected {kind}(s) appeared: {string.Join(", ", added.Take(5))}");
        }
    }
}
