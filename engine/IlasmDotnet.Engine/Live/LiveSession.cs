using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Runtime;

namespace IlasmDotnet.Engine.Live;

/// <summary>How the live code was obtained from a running process.</summary>
public enum LiveMode
{
    /// <summary>The target writes a snapshot of itself over the diagnostic socket; needs no ptrace.</summary>
    Snapshot,

    /// <summary>Read the target's memory directly. Needs ptrace, so usually only works for children.</summary>
    Attach,
}

public sealed record LiveAttachResult(
    int Pid,
    string Mode,
    string Runtime,
    int Modules,
    long SnapshotBytes,
    string Detail);

/// <summary>
/// One running .NET process, kept open so several methods can be inspected without paying for the
/// snapshot again.
/// </summary>
public sealed class LiveSession : IDisposable
{
    private readonly DataTarget _target;
    private readonly ClrRuntime _runtime;
    private readonly string? _snapshotPath;

    private LiveSession(DataTarget target, ClrRuntime runtime, int pid, LiveMode mode, string? snapshotPath, long snapshotBytes, string detail)
    {
        _target = target;
        _runtime = runtime;
        _snapshotPath = snapshotPath;
        Pid = pid;
        Mode = mode;
        SnapshotBytes = snapshotBytes;
        Detail = detail;
    }

    public int Pid { get; }

    public LiveMode Mode { get; }

    public long SnapshotBytes { get; }

    public string Detail { get; }

    public ClrRuntime Runtime => _runtime;

    /// <summary>
    /// Opens a session for a process. The default route asks the process itself to write a snapshot
    /// and analyses that, because reading another process's memory needs ptrace permission that a
    /// user session normally does not have.
    /// </summary>
    public static LiveSession Open(int pid, LiveMode mode, string? scratchDirectory)
    {
        if (!IsAlive(pid))
        {
            throw new InvalidOperationException($"Process {pid} is not running.");
        }

        if (mode == LiveMode.Snapshot)
        {
            var directory = scratchDirectory ?? Path.GetTempPath();
            var path = Path.Combine(directory, $"ilasm-dotnet-{pid}-{DateTime.UtcNow.Ticks}.dmp");

            var client = new DiagnosticsClient(pid);
            client.WriteDump(DumpType.WithHeap, path, logDumpGeneration: false);

            var size = new FileInfo(path).Length;
            var target = DataTarget.LoadDump(path);
            var runtime = target.ClrVersions.Length > 0
                ? OpenRuntime(target.ClrVersions[0], pid)
                : throw new InvalidOperationException("The snapshot contains no CLR runtime information.");

            return new LiveSession(target, runtime, pid, mode, path, size, $"snapshot {size / (1024 * 1024)} MB");
        }

        var attached = DataTarget.AttachToProcess(pid, suspend: false);
        var attachedRuntime = attached.ClrVersions.Length > 0
            ? OpenRuntime(attached.ClrVersions[0], pid)
            : throw new InvalidOperationException("No CLR runtime was found in the process.");

        return new LiveSession(attached, attachedRuntime, pid, mode, null, 0, "attached directly");
    }

    /// <summary>
    /// Opens the runtime of a target. ClrMD resolves the DAC that reads a runtime through a symbol
    /// locator and does not download one on Linux, which leaves the debugger with nothing to load.
    /// The runtime itself ships its DAC next to the coreclr it loads, and that is the one to use.
    /// A snapshot reports its runtime as 0.0, so only then may the version of the DAC differ from
    /// what the target claims; a DAC that really is another runtime stays an error.
    /// </summary>
    private static ClrRuntime OpenRuntime(ClrInfo info, int pid)
    {
        var dac = DacOfTarget(info, pid);
        if (dac is null)
        {
            return info.CreateRuntime();
        }

        // A snapshot reports its runtime as 0.0 instead of the version that produced it, and the DAC
        // refuses to load against that; the mismatch is allowed for that case only, because a DAC
        // belonging to a different runtime has to be refused.
        return info.CreateRuntime(dac, ignoreMismatch: info.Version.Major == 0);
    }

    /// <summary>The debugger library that belongs to the runtime the target loaded, if it is on disk.</summary>
    private static string? DacOfTarget(ClrInfo info, int pid)
    {
        var name = OperatingSystem.IsWindows() ? "mscordaccore.dll"
            : OperatingSystem.IsMacOS() ? "libmscordaccore.dylib"
            : "libmscordaccore.so";

        foreach (var directory in new[] { Path.GetDirectoryName(info.ModuleInfo.FileName), RuntimeDirectory(pid) })
        {
            if (string.IsNullOrEmpty(directory))
            {
                continue;
            }

            var candidate = Path.Combine(directory, name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// The framework directory the target runs from, taken from its mapped coreclr. A snapshot
    /// reports runtime version 0.0 and a single file application reports no module at all, so the
    /// maps are what still tells which runtime is on the other side.
    /// </summary>
    private static string? RuntimeDirectory(int pid)
    {
        try
        {
            foreach (var line in File.ReadLines($"/proc/{pid}/maps"))
            {
                var match = FrameworkPath.Match(line);
                if (match.Success)
                {
                    return match.Groups["directory"].Value;
                }
            }
        }
        catch (Exception)
        {
            // The maps file is not readable for every process.
        }

        return null;
    }

    /// <summary>A mapped file inside a runtime directory, for example ".../Microsoft.NETCore.App/8.0.31/libcoreclr.so".</summary>
    private static readonly Regex FrameworkPath = new(
        @"(?<directory>/\S*?Microsoft\.NETCore\.App/[^/\s]+)/",
        RegexOptions.Compiled);

    /// <summary>Finds the loaded module for an assembly path, comparing only the file name.</summary>
    public ClrModule? FindModule(string assemblyPath)
    {
        var fileName = Path.GetFileName(assemblyPath);
        return _runtime.EnumerateModules().FirstOrDefault(module =>
            string.Equals(Path.GetFileName(module.Name ?? string.Empty), fileName, StringComparison.OrdinalIgnoreCase));
    }

    public LiveAttachResult Describe() =>
        new(Pid, Mode.ToString(), ResolveRuntimeVersion(),
            _runtime.EnumerateModules().Count(), SnapshotBytes, Detail);

    /// <summary>
    /// The CLR version reported for a snapshot is often 0.0, so the version directory of the loaded
    /// coreclr is used instead. It is what the user expects to see next to the process.
    /// </summary>
    private string ResolveRuntimeVersion()
    {
        var reported = _runtime.ClrInfo?.Version;
        if (reported is not null && reported.Major > 0)
        {
            return reported.ToString();
        }

        return RuntimeDirectory(Pid) is { } directory ? Path.GetFileName(directory) : "unknown";
    }

    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        _target.Dispose();

        if (_snapshotPath is not null)
        {
            try
            {
                File.Delete(_snapshotPath);
            }
            catch (IOException)
            {
                // The snapshot is left behind only if the file is still mapped.
            }
        }
    }
}
