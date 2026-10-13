using System.Reflection;
using System.Runtime.CompilerServices;

namespace IlasmDotnet.Engine.Jit;

/// <summary>
/// Forces the runtime to JIT compile specific methods so the JIT can print their native code.
///
/// This runs as a child process of the engine, launched with the disassembly environment variables
/// set. Methods are resolved by metadata token, which keeps overloads unambiguous, and they are
/// compiled with <see cref="RuntimeHelpers.PrepareMethod(MethodHandle)"/> instead of being invoked,
/// so a method body is not executed just because someone asked to see its assembly. Module
/// initializers do still run, because that is part of loading an assembly.
/// </summary>
public static class JitDisasmHarness
{
    /// <summary>Runs the harness. Arguments after the mode flag are the assembly path then method tokens.</summary>
    public static int Run(IReadOnlyList<string> args)
    {
        // args[0] is the --jit-disasm mode flag itself.
        var payload = args.Skip(1).ToList();
        if (payload.Count < 2)
        {
            Console.Error.WriteLine("usage: --jit-disasm <assembly> <method-token> [...]");
            return 2;
        }

        Assembly assembly;
        try
        {
            assembly = Assembly.LoadFrom(Path.GetFullPath(payload[0]));
        }
        catch (Exception ex)
        {
            Console.Out.WriteLine($"[jit] load-failed {ex.GetType().Name}: {ex.Message}");
            Console.Out.Flush();
            return 3;
        }

        Console.Out.WriteLine($"[jit] runtime {Environment.Version}");

        foreach (var raw in payload.Skip(1))
        {
            Console.Out.WriteLine($"[jit] begin {raw}");
            Console.Out.Flush();

            if (!int.TryParse(raw, out var token))
            {
                Console.Out.WriteLine($"[jit] error {raw} token is not a number");
                continue;
            }

            try
            {
                var method = ResolveByToken(assembly, token);
                if (method is null)
                {
                    Console.Out.WriteLine($"[jit] error {raw} the token does not resolve to a method");
                    continue;
                }

                Prepare(method);
                Console.Out.WriteLine($"[jit] prepared {raw}");
            }
            catch (Exception ex)
            {
                Console.Out.WriteLine($"[jit] error {raw} {ex.GetType().Name}: {ex.Message}");
            }

            Console.Out.Flush();
        }

        return 0;
    }

    private static MethodBase? ResolveByToken(Assembly assembly, int token)
    {
        try
        {
            // Resolving by token avoids the name ambiguity that overloads and explicit interface
            // implementations would otherwise cause.
            return assembly.ManifestModule.ResolveMethod(token);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void Prepare(MethodBase method)
    {
        if (method is MethodInfo info)
        {
            if (info.IsGenericMethodDefinition)
            {
                // An open generic cannot be compiled, so use a reference instantiation to still
                // produce a representative body.
                info = info.MakeGenericMethod(info.GetGenericArguments().Select(_ => typeof(object)).ToArray());
            }

            RuntimeHelpers.PrepareMethod(info.MethodHandle);
            return;
        }

        RuntimeHelpers.PrepareMethod(method.MethodHandle);
    }
}
