using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using ICSharpCode.Decompiler.DebugInfo;
using DbgSequencePoint = ICSharpCode.Decompiler.DebugInfo.SequencePoint;

namespace IlasmDotnet.Engine.Metadata;

/// <summary>
/// Reads a portable PDB and exposes it through <see cref="IDebugInfoProvider"/> so the
/// decompiler and the IL disassembler can annotate their output with original source positions.
/// </summary>
public sealed class PortablePdbInfoProvider : IDebugInfoProvider, IDisposable
{
    private readonly FileStream _stream;
    private readonly MetadataReaderProvider _provider;
    private readonly MetadataReader _pdb;
    private readonly Dictionary<int, IReadOnlyList<DbgSequencePoint>> _sequencePointCache = new();
    private readonly Dictionary<int, IReadOnlyList<Variable>> _variableCache = new();

    public PortablePdbInfoProvider(string pdbPath)
    {
        Path = pdbPath;
        _stream = File.OpenRead(pdbPath);
        _provider = MetadataReaderProvider.FromPortablePdbStream(_stream, MetadataStreamOptions.PrefetchMetadata);
        _pdb = _provider.GetMetadataReader();
    }

    public string Path { get; }

    public string Description => "Portable PDB";

    public string SourceFileName => string.Empty;

    public IReadOnlyList<DbgSequencePoint> GetSequencePoints(int methodToken)
    {
        if (_sequencePointCache.TryGetValue(methodToken, out var cached))
        {
            return cached;
        }

        var result = new List<DbgSequencePoint>();
        var handle = MetadataTokens.MethodDefinitionHandle(methodToken);        if (!handle.IsNil)
        {
            var debugInfo = _pdb.GetMethodDebugInformation(handle.ToDebugInformationHandle());
            foreach (var point in debugInfo.GetSequencePoints())
            {
                if (point.IsHidden)
                {
                    continue;
                }

                result.Add(new DbgSequencePoint
                {
                    Offset = point.Offset,
                    EndOffset = point.Offset,
                    StartLine = point.StartLine,
                    StartColumn = point.StartColumn,
                    EndLine = point.EndLine,
                    EndColumn = point.EndColumn,
                    DocumentUrl = GetDocumentUrl(point.Document),
                });
            }
        }

        result.Sort(static (a, b) => a.Offset.CompareTo(b.Offset));
        _sequencePointCache[methodToken] = result;
        return result;
    }

    public IList<DbgSequencePoint> GetSequencePoints(MethodDefinitionHandle method)
    {
        var token = MetadataTokens.GetToken(method);
        return GetSequencePoints(token).ToList();
    }

    public IList<Variable> GetVariables(MethodDefinitionHandle method)
    {
        var token = MetadataTokens.GetToken(method);
        if (_variableCache.TryGetValue(token, out var cached))
        {
            return cached.ToList();
        }

        var variables = new List<Variable>();
        foreach (var (index, name) in ReadLocals(method))
        {
            variables.Add(new Variable(index, name));
        }

        _variableCache[token] = variables;
        return variables;
    }

    public bool TryGetName(MethodDefinitionHandle method, int index, out string name)
    {
        foreach (var local in ReadLocals(method))
        {
            if (local.Index == index)
            {
                name = local.Name;
                return true;
            }
        }

        name = string.Empty;
        return false;
    }

    public bool TryGetExtraTypeInfo(MethodDefinitionHandle method, int index, out PdbExtraTypeInfo extraTypeInfo)
    {
        extraTypeInfo = default;
        return false;
    }

    private IEnumerable<(int Index, string Name)> ReadLocals(MethodDefinitionHandle method)
    {
        foreach (var scopeHandle in _pdb.GetLocalScopes(method))
        {
            var scope = _pdb.GetLocalScope(scopeHandle);
            foreach (var localHandle in scope.GetLocalVariables())
            {
                var local = _pdb.GetLocalVariable(localHandle);
                if (local.Attributes == LocalVariableAttributes.DebuggerHidden)
                {
                    continue;
                }

                yield return (local.Index, _pdb.GetString(local.Name));
            }
        }
    }

    private string GetDocumentUrl(DocumentHandle handle)
    {
        if (handle.IsNil)
        {
            return string.Empty;
        }

        var document = _pdb.GetDocument(handle);
        return _pdb.GetString(document.Name);
    }

    public void Dispose()
    {
        _provider.Dispose();
        _stream.Dispose();
    }

    /// <summary>Looks for a portable PDB next to the given assembly.</summary>
    public static string? FindPdb(string assemblyPath)
    {
        var candidate = System.IO.Path.ChangeExtension(assemblyPath, ".pdb");
        return File.Exists(candidate) ? candidate : null;
    }
}
