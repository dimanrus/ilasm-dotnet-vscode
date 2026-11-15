using System;
using System.Threading.Tasks;

namespace RuntimeAsync;

internal static class Program
{
    private static async Task<int> Main()
    {
        Console.WriteLine(await ComputeAsync(41));
        return 0;
    }

    public static async Task<int> ComputeAsync(int value)
    {
        await Task.Yield();
        return value + 1;
    }

    public static async ValueTask<int> DoubleAsync(int value)
    {
        var result = await Task.FromResult(value);
        return result * 2;
    }

    // A named implementation attribute next to the async one, so the listing has to spell both.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    public static async Task<int> NoInliningAsync(int value) => await Task.FromResult(value);
}
