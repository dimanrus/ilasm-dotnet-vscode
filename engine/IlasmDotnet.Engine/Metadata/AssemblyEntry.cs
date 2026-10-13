using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using IlasmDotnet.Engine.Bundle;
using IlasmDotnet.Engine.Model;
using IlasmDotnet.Engine.Views.ReadyToRun;

namespace IlasmDotnet.Engine.Metadata;

/// <summary>Reference to a member of a type as it should be presented to the client.</summary>
public readonly record struct MemberRef(EntityHandle Handle, string Kind);

/// <summary>One opened assembly together with its optional PDB and decompiler.</summary>
public sealed class AssemblyEntry : IDisposable
{
    private readonly PEFile _pe;
    private readonly PortablePdbInfoProvider? _pdb;
    private readonly UniversalAssemblyResolver _resolver;
    private CSharpDecompiler? _decompilerLowLevel;

    public AssemblyEntry(string path)
    {
        Path = System.IO.Path.GetFullPath(path);

        // A program published into a single file is a native host with its assemblies appended, so it
        // has to be taken apart before anything else can read it. Only a file that holds no bundle is
        // refused as a native image.
        using (var singleFile = SingleFileApplication.TryOpen(Path))
        {
            if (singleFile is not null)
            {
                var directory = singleFile.ExtractionDirectory();
                ReadablePath = singleFile.ExtractTo(directory)
                    ?? throw new InvalidOperationException(
                        $"{System.IO.Path.GetFileName(Path)} is a single file application, but the bundle inside it holds no assembly that can be read.");
                BundleDirectory = directory;
            }
            else
            {
                // Every read of an assembly goes through here, so this is the one place that can tell a
                // native image from a managed one before the metadata reader reports "unknown format".
                if (NativeImage.Explain(Path) is { } reason)
                {
                    throw new InvalidOperationException(reason);
                }

                ReadablePath = Path;
            }
        }

        _pe = new PEFile(ReadablePath);

        // The symbols of a single file application are written beside the executable, while the
        // assembly they describe was taken out of it; both places are tried.
        var pdbPath = PortablePdbInfoProvider.FindPdb(ReadablePath) ?? PortablePdbInfoProvider.FindPdb(Path);
        if (pdbPath is not null && BelongsToAssembly(pdbPath))
        {
            try
            {
                _pdb = new PortablePdbInfoProvider(pdbPath);
            }
            catch (Exception)
            {
                _pdb = null;
            }
        }

        // References are resolved from the directory the assembly was read from: for a single file
        // application that is the one the whole bundle was taken apart into.
        _resolver = new UniversalAssemblyResolver(ReadablePath, throwOnError: false, targetFramework: null);
        var settings = new DecompilerSettings
        {
            RemoveDeadCode = true,
            RemoveDeadStores = true,
            UseDebugSymbols = true,
        };

        Decompiler = new CSharpDecompiler(ReadablePath, _resolver, settings) { DebugInfoProvider = _pdb };
    }

    public string Path { get; }

    /// <summary>
    /// The file the metadata is read from. It is the file that was opened, unless that file is a
    /// single file application: then it is the assembly taken out of the bundle inside it, and the
    /// directory beside it holds every other assembly the bundle carried.
    /// </summary>
    public string ReadablePath { get; } = string.Empty;

    /// <summary>The directory a single file bundle was taken apart into, when that is what happened.</summary>
    public string? BundleDirectory { get; }

    /// <summary>
    /// Whether the portable PDB next to the assembly is the one it was built with. A build writes both
    /// files together, but a half-finished build, or a copy of one file next to the other, leaves a PDB
    /// of a different assembly behind. Its sequence points would then be read as if they described this
    /// assembly: the lengths do not match, and reading them runs off the end of a blob instead of
    /// simply finding no source. The identifier in the PDB has to be the one the assembly points at.
    /// </summary>
    private bool BelongsToAssembly(string pdbPath)
    {
        try
        {
            using var pdb = MetadataReaderProvider.FromPortablePdbStream(File.OpenRead(pdbPath));
            var id = pdb.GetMetadataReader().DebugMetadataHeader.Id;
            if (id.Length < 16)
            {
                return false;
            }

            using var pe = new PEReader(File.OpenRead(ReadablePath));
            var directory = pe.ReadDebugDirectory().FirstOrDefault(entry => entry.Type == DebugDirectoryEntryType.CodeView);
            return directory.Type == DebugDirectoryEntryType.CodeView && pe.ReadCodeViewDebugDirectoryData(directory).Guid == new Guid(id.AsSpan(0, 16));
        }
        catch (Exception)
        {
            // A PDB that cannot be read is not one this assembly can be read with.
            return false;
        }
    }

    public PEFile PE => _pe;

    public PortablePdbInfoProvider? Pdb => _pdb;

    public CSharpDecompiler Decompiler { get; }

    /// <summary>
    /// Decompiler with the high-level transformations off, which is what the low-level C# view shows:
    /// the shapes the compiler produces instead of the sugar the code was written with. It is built on
    /// first use, because an assembly that is only ever read in one of the two ways never pays for the
    /// other.
    /// </summary>
    public CSharpDecompiler DecompilerLowLevel =>
        _decompilerLowLevel ??= new CSharpDecompiler(Path, _resolver, LowLevelSettings()) { DebugInfoProvider = _pdb };

    /// <summary>
    /// Settings that turn the syntax sugar back into what the compiler emitted: loops stay loops over
    /// enumerators, lambdas stay anonymous methods, await and yield stay state machines, and the
    /// shorter spellings become the calls behind them. Nothing is removed either, so the dead branches
    /// a debug build carries stay visible.
    /// </summary>
    public static DecompilerSettings LowLevelSettings() => new()
    {
        RemoveDeadCode = false,
        RemoveDeadStores = false,
        UseDebugSymbols = true,
        AlwaysUseBraces = true,
        SeparateLocalVariableDeclarations = true,
        AnonymousMethods = false,
        AnonymousTypes = false,
        ArrayInitializers = false,
        AsyncAwait = false,
        AsyncEnumerator = false,
        AsyncUsingAndForEachStatement = false,
        AutomaticEvents = false,
        AutomaticProperties = false,
        AwaitInCatchFinally = false,
        CheckedOperators = false,
        DecimalConstants = false,
        Deconstruction = false,
        DefaultLiterals = false,
        DictionaryInitializers = false,
        Discards = false,
        DoWhileStatement = false,
        ExtensionMembers = false,
        ExtensionMethods = false,
        FieldKeyword = false,
        FileScopedNamespaces = false,
        ForEachStatement = false,
        ForStatement = false,
        GetterOnlyAutomaticProperties = false,
        InitAccessors = false,
        IntroduceIncrementAndDecrement = false,
        IntroducePrivateProtectedAccessibility = false,
        IntroduceReadonlyAndInModifiers = false,
        IntroduceRefModifiersOnStructs = false,
        IntroduceUnmanagedConstraint = false,
        LambdaOptionalAndParamsParameters = false,
        ScopedRef = false,
        LocalFunctions = false,
        LockStatement = false,
        MakeAssignmentExpressions = false,
        NamedArguments = false,
        NullPropagation = false,
        ObjectOrCollectionInitializers = false,
        OptionalArguments = false,
        OutVariables = false,
        ParamsCollections = false,
        PatternMatching = false,
        QueryExpressions = false,
        Ranges = false,
        RecordClasses = false,
        RecordStructs = false,
        RecursivePatternMatching = false,
        RelationalPatterns = false,
        SparseIntegerSwitch = false,
        StaticLocalFunctions = false,
        StringConcat = false,
        StringInterpolation = false,
        SwitchExpressions = false,
        SwitchStatementOnString = false,
        ThrowExpressions = false,
        TupleTypes = false,
        UseEnhancedUsing = false,
        UseExpressionBodyForCalculatedGetterOnlyProperties = false,
        UseImplicitMethodGroupConversion = false,
        UseLambdaSyntax = false,
        UsePrimaryConstructorSyntax = false,
        UsePrimaryConstructorSyntaxForNonRecordTypes = false,
        UsingDeclarations = false,
        UsingStatement = false,
        WithExpressions = false,
        YieldReturn = false,
    };

    public MetadataReader Metadata => _pe.Metadata;

    public AssemblyInfoDto Describe()
    {
        string name;
        string version;
        try
        {
            var assembly = _pe.Metadata.GetAssemblyDefinition();
            name = _pe.Metadata.GetString(assembly.Name);
            version = assembly.Version.ToString();
        }
        catch (BadImageFormatException)
        {
            name = System.IO.Path.GetFileNameWithoutExtension(Path);
            version = string.Empty;
        }

        if (string.IsNullOrEmpty(name))
        {
            name = System.IO.Path.GetFileNameWithoutExtension(Path);
        }

        return new AssemblyInfoDto(
            Path,
            name,
            version,
            DetectTargetFramework(),
            DetectArchitecture(),
            IsExecutable(),
            _pdb is not null,
            _pe.Metadata.TypeDefinitions.Count);
    }

    private string DetectTargetFramework()
    {
        try
        {
            return DotNetCorePathFinderExtensions.DetectTargetFrameworkId(_pe) ?? string.Empty;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private string DetectArchitecture()
    {
        try
        {
            var headers = _pe.Reader.PEHeaders;
            var machine = headers.CoffHeader.Machine;

            // An image published for a unix target is marked with a machine value of its own, which has
            // no name in the enumeration the reader hands out: without the table the image of a linux
            // build would be described by the number of that value.
            switch (ReadyToRunImage.ArchitectureOf(machine))
            {
                case ImageArchitecture.X64:
                    return "x64";
                case ImageArchitecture.Arm64:
                    return "ARM64";
            }

            var corFlags = _pe.Reader.PEHeaders.CorHeader?.Flags ?? CorFlags.ILOnly;
            var requires32Bit = (corFlags & CorFlags.Requires32Bit) != 0;

            return machine switch
            {
                Machine.I386 => requires32Bit ? "x86" : "AnyCPU",
                Machine.Unknown => "AnyCPU",
                _ => machine.ToString(),
            };
        }
        catch (Exception)
        {
            return "AnyCPU";
        }
    }

    private bool IsExecutable()
    {
        try
        {
            var characteristics = _pe.Reader.PEHeaders.CoffHeader.Characteristics;
            return (characteristics & Characteristics.Dll) == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public IEnumerable<TypeDefinitionHandle> EnumerateTypes() => _pe.Metadata.TypeDefinitions;

    public static int TokenOf(EntityHandle handle) => handle.IsNil ? 0 : MetadataTokens.GetToken(handle);

    public TypeDto DescribeType(TypeDefinitionHandle handle)
    {
        var type = _pe.Metadata.GetTypeDefinition(handle);
        var name = _pe.Metadata.GetString(type.Name);
        var ns = _pe.Metadata.GetString(type.Namespace);
        var fullName = GetFullName(handle);
        var nested = type.GetNestedTypes().Length;

        return new TypeDto(
            TokenOf(handle),
            nested > 0 ? name : (string.IsNullOrEmpty(ns) ? name : ns + "." + name),
            ns,
            fullName,
            GetTypeKind(type),
            GetTypeAccessibility(type.Attributes),
            type.GetMethods().Count,
            nested);
    }

    public string GetFullName(TypeDefinitionHandle handle)
    {
        var type = _pe.Metadata.GetTypeDefinition(handle);
        var name = _pe.Metadata.GetString(type.Name);
        if (!type.IsNested)
        {
            var ns = _pe.Metadata.GetString(type.Namespace);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        var declaring = type.GetDeclaringType();
        return declaring.IsNil ? name : GetFullName(declaring) + "." + name;
    }

    public IReadOnlyList<MemberDto> ListMembers(TypeDefinitionHandle handle)
    {
        var type = _pe.Metadata.GetTypeDefinition(handle);
        var declaringType = GetFullName(handle);
        var members = new List<MemberDto>();

        foreach (var fieldHandle in type.GetFields())
        {
            var field = _pe.Metadata.GetFieldDefinition(fieldHandle);
            members.Add(new MemberDto(
                TokenOf(fieldHandle),
                _pe.Metadata.GetString(field.Name),
                "field",
                DescribeMemberHeader(d => d.DisassembleFieldHeader(_pe, fieldHandle)),
                declaringType));
        }

        foreach (var methodHandle in type.GetMethods())
        {
            var method = _pe.Metadata.GetMethodDefinition(methodHandle);
            members.Add(new MemberDto(
                TokenOf(methodHandle),
                _pe.Metadata.GetString(method.Name),
                GetMethodKind(method),
                DescribeMemberHeader(d => d.DisassembleMethodHeader(_pe, methodHandle)),
                declaringType));
        }

        foreach (var propertyHandle in type.GetProperties())
        {
            var property = _pe.Metadata.GetPropertyDefinition(propertyHandle);
            members.Add(new MemberDto(
                TokenOf(propertyHandle),
                _pe.Metadata.GetString(property.Name),
                "property",
                DescribeMemberHeader(d => d.DisassemblePropertyHeader(_pe, propertyHandle)),
                declaringType));
        }

        foreach (var eventHandle in type.GetEvents())
        {
            var @event = _pe.Metadata.GetEventDefinition(eventHandle);
            members.Add(new MemberDto(
                TokenOf(eventHandle),
                _pe.Metadata.GetString(@event.Name),
                "event",
                DescribeMemberHeader(d => d.DisassembleEventHeader(_pe, eventHandle)),
                declaringType));
        }

        return members;
    }

    /// <summary>
    /// Method definition tokens of a type, including nested types, in the same order the
    /// reflection disassembler walks them. Used to attribute IL offsets to a method body.
    /// </summary>
    public IReadOnlyList<int> GetMethodTokensInDisassemblyOrder(TypeDefinitionHandle handle)
    {
        var tokens = new List<int>();
        CollectMethodTokens(handle, tokens);
        return tokens;
    }

    private void CollectMethodTokens(TypeDefinitionHandle handle, List<int> tokens)
    {
        var type = _pe.Metadata.GetTypeDefinition(handle);
        foreach (var methodHandle in type.GetMethods())
        {
            tokens.Add(TokenOf(methodHandle));
        }

        foreach (var nested in type.GetNestedTypes())
        {
            CollectMethodTokens(nested, tokens);
        }
    }

    /// <summary>Length of a method body in bytes, or 0 when the method has no body.</summary>
    public int GetMethodBodySize(int methodToken)
    {
        try
        {
            var method = _pe.Metadata.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(methodToken));
            var rva = method.RelativeVirtualAddress;
            if (rva == 0)
            {
                return 0;
            }

            return _pe.GetMethodBody(rva).GetILContent().Length;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    /// <summary>
    /// Property or event an accessor belongs to, or a nil handle for a method that is not an
    /// accessor. C# has no syntax for a lone accessor, so its views show the property or event.
    /// </summary>
    public EntityHandle FindAccessorOwner(EntityHandle handle)
    {
        if (handle.Kind != HandleKind.MethodDefinition)
        {
            return default;
        }

        var method = (MethodDefinitionHandle)handle;
        var type = _pe.Metadata.GetTypeDefinition(_pe.Metadata.GetMethodDefinition(method).GetDeclaringType());

        foreach (var propertyHandle in type.GetProperties())
        {
            var accessors = _pe.Metadata.GetPropertyDefinition(propertyHandle).GetAccessors();
            if (accessors.Getter == method || accessors.Setter == method)
            {
                return propertyHandle;
            }
        }

        foreach (var eventHandle in type.GetEvents())
        {
            var accessors = _pe.Metadata.GetEventDefinition(eventHandle).GetAccessors();
            if (accessors.Adder == method || accessors.Remover == method || accessors.Raiser == method)
            {
                return eventHandle;
            }
        }

        return default;
    }

    /// <summary>Name of a property or event handle, i.e. the name an accessor stands for.</summary>
    public string GetPropertyOrEventName(EntityHandle handle) => handle.Kind switch
    {
        HandleKind.PropertyDefinition => _pe.Metadata.GetString(_pe.Metadata.GetPropertyDefinition((PropertyDefinitionHandle)handle).Name),
        HandleKind.EventDefinition => _pe.Metadata.GetString(_pe.Metadata.GetEventDefinition((EventDefinitionHandle)handle).Name),
        _ => string.Empty,
    };

    /// <summary>
    /// The property or event an accessor belongs to plus the role it plays there, as a picker
    /// wants to show it: `Count` and `get` instead of a bare `get_Count`.
    /// </summary>
    public (string? Owner, string? Accessor) DescribeAccessor(MethodDefinitionHandle method)
    {
        var owner = FindAccessorOwner(method);
        if (owner.IsNil)
        {
            return (null, null);
        }

        var name = _pe.Metadata.GetString(_pe.Metadata.GetMethodDefinition(method).Name);
        var role = name.StartsWith("get_", StringComparison.Ordinal) ? "get"
            : name.StartsWith("set_", StringComparison.Ordinal) ? "set"
            : name.StartsWith("add_", StringComparison.Ordinal) ? "add"
            : name.StartsWith("remove_", StringComparison.Ordinal) ? "remove"
            : "accessor";

        return (GetPropertyOrEventName(owner), role);
    }

    /// <summary>
    /// A type and the types it is nested in, from the inside out. The body of an async or iterator
    /// method is compiled into a state machine nested in the type that declared the method, so a token
    /// of that generated type is also a token of the type a reader knows.
    /// </summary>
    public IReadOnlyList<TypeDefinitionHandle> EnclosingTypes(TypeDefinitionHandle handle)
    {
        var chain = new List<TypeDefinitionHandle> { handle };
        var type = _pe.Metadata.GetTypeDefinition(handle);

        while (type.IsNested)
        {
            handle = type.GetDeclaringType();
            chain.Add(handle);
            type = _pe.Metadata.GetTypeDefinition(handle);
        }

        return chain;
    }

    /// <summary>Finds the type that declares a property or event handle.</summary>
    public TypeDefinitionHandle FindDeclaringType(Handle handle)
    {
        foreach (var typeHandle in EnumerateTypes())
        {
            var type = _pe.Metadata.GetTypeDefinition(typeHandle);
            switch (handle.Kind)
            {
                case HandleKind.PropertyDefinition when type.GetProperties().Contains((PropertyDefinitionHandle)handle):
                case HandleKind.EventDefinition when type.GetEvents().Contains((EventDefinitionHandle)handle):
                    return typeHandle;
            }
        }

        return default;
    }

    private string DescribeMemberHeader(Action<ReflectionDisassembler> write)
    {
        var writer = new StringWriter();
        var output = new PlainTextOutput(writer) { IndentationString = "    " };
        var disassembler = new ReflectionDisassembler(output, CancellationToken.None)
        {
            DetectControlStructure = false,
            ShowMetadataTokens = false,
        };

        try
        {
            write(disassembler);
            return NormalizeHeader(writer.ToString());
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static string NormalizeHeader(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.EndsWith('{'))
        {
            trimmed = trimmed[..^1].TrimEnd();
        }

        foreach (var prefix in new[] { ".method", ".field", ".property", ".event" })
        {
            if (trimmed.StartsWith(prefix, StringComparison.Ordinal))
            {
                trimmed = trimmed[prefix.Length..].TrimStart();
                break;
            }
        }

        return string.Join(' ', trimmed.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    private string GetTypeKind(TypeDefinition type)
    {
        var attributes = type.Attributes;
        if ((attributes & TypeAttributes.Interface) != 0)
        {
            return "interface";
        }

        var baseName = GetBaseTypeName(type);
        return baseName switch
        {
            "System.Enum" => "enum",
            "System.ValueType" => "struct",
            "System.MulticastDelegate" => "delegate",
            _ => "class",
        };
    }

    private string GetBaseTypeName(TypeDefinition type)
    {
        var baseType = type.BaseType;
        if (baseType.IsNil)
        {
            return string.Empty;
        }

        switch (baseType.Kind)
        {
            case HandleKind.TypeReference:
                var reference = _pe.Metadata.GetTypeReference((TypeReferenceHandle)baseType);
                var ns = _pe.Metadata.GetString(reference.Namespace);
                var name = _pe.Metadata.GetString(reference.Name);
                return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
            case HandleKind.TypeDefinition:
                return GetFullName((TypeDefinitionHandle)baseType);
            default:
                return string.Empty;
        }
    }

    /// <summary>Members of a type in display order, including a marker entry for each nested type.</summary>
    public IReadOnlyList<MemberRef> EnumerateMembers(TypeDefinitionHandle typeHandle, bool includeCompilerGenerated)
    {
        var type = _pe.Metadata.GetTypeDefinition(typeHandle);
        var result = new List<MemberRef>();

        foreach (var handle in type.GetMethods())
        {
            var name = _pe.Metadata.GetString(_pe.Metadata.GetMethodDefinition(handle).Name);
            if (IsHidden(name, includeCompilerGenerated))
            {
                continue;
            }

            result.Add(new MemberRef(handle, GetMethodKind(_pe.Metadata.GetMethodDefinition(handle))));
        }

        foreach (var handle in type.GetProperties())
        {
            var name = _pe.Metadata.GetString(_pe.Metadata.GetPropertyDefinition(handle).Name);
            if (IsHidden(name, includeCompilerGenerated))
            {
                continue;
            }

            result.Add(new MemberRef(handle, "property"));
        }

        foreach (var handle in type.GetFields())
        {
            var name = _pe.Metadata.GetString(_pe.Metadata.GetFieldDefinition(handle).Name);
            if (IsHidden(name, includeCompilerGenerated))
            {
                continue;
            }

            result.Add(new MemberRef(handle, "field"));
        }

        foreach (var handle in type.GetEvents())
        {
            var name = _pe.Metadata.GetString(_pe.Metadata.GetEventDefinition(handle).Name);
            if (IsHidden(name, includeCompilerGenerated))
            {
                continue;
            }

            result.Add(new MemberRef(handle, "event"));
        }

        foreach (var handle in type.GetNestedTypes())
        {
            var name = _pe.Metadata.GetString(_pe.Metadata.GetTypeDefinition(handle).Name);
            if (IsHidden(name, includeCompilerGenerated))
            {
                continue;
            }

            result.Add(new MemberRef(handle, "nestedtype"));
        }

        return result;
    }

    /// <summary>Type name as reflection reports it, with nested types separated by '+' and generic arity kept.</summary>
    public string GetReflectionTypeName(TypeDefinitionHandle handle)
    {
        var type = _pe.Metadata.GetTypeDefinition(handle);
        var name = _pe.Metadata.GetString(type.Name);
        if (!type.IsNested)
        {
            var ns = _pe.Metadata.GetString(type.Namespace);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        var declaring = type.GetDeclaringType();
        return declaring.IsNil ? name : GetReflectionTypeName(declaring) + "+" + name;
    }

    /// <summary>Type that declares a method.</summary>
    public TypeDefinitionHandle GetDeclaringTypeOfMethod(MethodDefinitionHandle handle) =>
        _pe.Metadata.GetMethodDefinition(handle).GetDeclaringType();

    /// <summary>Method name as the runtime reports it, which is what the JIT pattern and reflection use.</summary>
    public string GetClrMethodName(MethodDefinitionHandle handle) =>
        _pe.Metadata.GetString(_pe.Metadata.GetMethodDefinition(handle).Name);

    /// <summary>Method handles that provide the body for a member: the method itself or the property/event accessors.</summary>
    public IReadOnlyList<MethodDefinitionHandle> GetAccessors(EntityHandle handle)
    {
        switch (handle.Kind)
        {
            case HandleKind.MethodDefinition:
                return new[] { (MethodDefinitionHandle)handle };
            case HandleKind.PropertyDefinition:
            {
                var accessors = _pe.Metadata.GetPropertyDefinition((PropertyDefinitionHandle)handle).GetAccessors();
                var result = new List<MethodDefinitionHandle>();
                if (!accessors.Getter.IsNil)
                {
                    result.Add(accessors.Getter);
                }

                if (!accessors.Setter.IsNil)
                {
                    result.Add(accessors.Setter);
                }

                return result;
            }
            case HandleKind.EventDefinition:
            {
                var accessors = _pe.Metadata.GetEventDefinition((EventDefinitionHandle)handle).GetAccessors();
                var result = new List<MethodDefinitionHandle>();
                if (!accessors.Adder.IsNil)
                {
                    result.Add(accessors.Adder);
                }

                if (!accessors.Remover.IsNil)
                {
                    result.Add(accessors.Remover);
                }

                if (!accessors.Raiser.IsNil)
                {
                    result.Add(accessors.Raiser);
                }

                return result;
            }
            default:
                return Array.Empty<MethodDefinitionHandle>();
        }
    }

    public string GetMemberSignature(EntityHandle handle) => handle.Kind switch
    {
        HandleKind.MethodDefinition => DescribeMemberHeader(d => d.DisassembleMethodHeader(_pe, (MethodDefinitionHandle)handle)),
        HandleKind.FieldDefinition => DescribeMemberHeader(d => d.DisassembleFieldHeader(_pe, (FieldDefinitionHandle)handle)),
        HandleKind.PropertyDefinition => DescribeMemberHeader(d => d.DisassemblePropertyHeader(_pe, (PropertyDefinitionHandle)handle)),
        HandleKind.EventDefinition => DescribeMemberHeader(d => d.DisassembleEventHeader(_pe, (EventDefinitionHandle)handle)),
        HandleKind.TypeDefinition => GetFullName((TypeDefinitionHandle)handle),
        _ => handle.Kind.ToString(),
    };

    /// <summary>Overall original source span of a method body, or empty when no PDB information exists.</summary>
    public (string? File, int StartLine, int EndLine) GetSourceSpan(int methodToken)
    {
        var points = _pdb?.GetSequencePoints(methodToken);
        if (points is null || points.Count == 0)
        {
            return (null, 0, 0);
        }

        var start = int.MaxValue;
        var end = 0;
        string? file = null;
        foreach (var point in points)
        {
            if (string.IsNullOrEmpty(point.DocumentUrl))
            {
                continue;
            }

            file ??= point.DocumentUrl;
            start = Math.Min(start, point.StartLine);
            end = Math.Max(end, point.EndLine);
        }

        return start == int.MaxValue ? (null, 0, 0) : (file, start, end);
    }

    private static bool IsHidden(string name, bool includeCompilerGenerated) =>
        !includeCompilerGenerated && name.StartsWith('<');

    private string GetMethodKind(MethodDefinition method)
    {
        var name = _pe.Metadata.GetString(method.Name);
        return name switch
        {
            ".ctor" => "constructor",
            ".cctor" => "static constructor",
            _ => "method",
        };
    }

    private static string GetTypeAccessibility(TypeAttributes attributes) => (attributes & TypeAttributes.VisibilityMask) switch
    {
        TypeAttributes.Public => "public",
        TypeAttributes.NestedPublic => "public",
        TypeAttributes.NestedPrivate => "private",
        TypeAttributes.NestedFamily => "protected",
        TypeAttributes.NestedAssembly => "internal",
        TypeAttributes.NestedFamORAssem => "protected internal",
        TypeAttributes.NestedFamANDAssem => "private protected",
        _ => "internal",
    };

    public void Dispose()
    {
        _pdb?.Dispose();
        _pe.Dispose();
    }
}
