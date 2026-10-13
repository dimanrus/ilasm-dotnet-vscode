namespace IlasmDotnet.Engine.Native;

/// <summary>
/// Reads a native image and prints what the route made of it. The engine itself is a server, so
/// without this the only way to see whether an image was understood is to open an editor and look;
/// this is the same read as a command, which is what a diagnosis of an image nobody can explain
/// needs. It also runs as a child of the tests, where there is no editor at all.
/// </summary>
public static class NativeProbe
{
    public static int Run(IReadOnlyList<string> args)
    {
        if (args.Count < 1)
        {
            Console.Error.WriteLine("usage: --native <image> [method address]");
            return 2;
        }

        try
        {
            var entry = NativeImageEntry.Open(args[0]);
            Console.WriteLine($"image      {entry.Path}");
            Console.WriteLine($"machine    {entry.MachineName}");
            Console.WriteLine($"debug      {entry.DebugFile ?? "<none>"}");
            Console.WriteLine($"methods    {entry.MethodCount} ({entry.Methods.Count(method => !method.IsRuntime)} of the application)");
            Console.WriteLine($"names      {(entry.Note is null ? "complete" : "partial")}");
            if (entry.Note is not null)
            {
                Console.WriteLine($"note       {entry.Note}");
            }

            var withSource = entry.Methods.Where(method => method.File.Length > 0).ToList();
            Console.WriteLine($"source     {withSource.Count} method(s) mapped to a file");

            foreach (var method in entry.Methods.Where(method => !method.IsRuntime).Take(20))
            {
                var file = method.File.Length > 0 ? $"{System.IO.Path.GetFileName(method.File)}:{method.Line}" : "<no source>";
                Console.WriteLine($"  {method.FullName,-60} 0x{method.Address:x8} {method.Size,6} bytes  {file}");
            }

            var address = args.Count > 1 && int.TryParse(args[1], out var parsed)
                ? parsed
                : withSource.FirstOrDefault(method => !method.IsRuntime)?.Address ?? 0;

            if (address != 0 && entry.MethodAt(address) is { } chosen)
            {
                var view = entry.Asm(chosen, null);
                Console.WriteLine($"\n{view.Title}: {view.Text.Split('\n').Length} lines, {view.Blocks.Count} block(s)");
                Console.WriteLine(string.Join('\n', view.Text.Split('\n').Take(30)));
            }

            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"[native] {error.GetType().Name}: {error.Message}");
            return 1;
        }
    }
}
