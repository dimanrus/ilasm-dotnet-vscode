namespace LiveTarget;

/// <summary>
/// A long running program used by the tests. It warms a few methods up so the runtime has compiled
/// them by the time a test snapshot is taken, then it waits to be inspected.
/// </summary>
public static class Target
{
    public static int Add(int a, int b) => a + b;

    public static string Describe(int value)
    {
        if (value < 0)
        {
            return "negative";
        }

        return value switch
        {
            0 => "zero",
            < 10 => "small",
            _ => "large",
        };
    }

    public static decimal Total(IEnumerable<int> values)
    {
        decimal total = 0;
        foreach (var value in values)
        {
            total += value;
        }

        return total;
    }

    /// <summary>
    /// Exercises every kind of exception handler: two catches, a filter and a finally. The ILASM
    /// round-trip needs it, because handlers are the part of the listing an assembler is strictest
    /// about.
    /// </summary>
    public static string Guard(int value)
    {
        try
        {
            return value < 0 ? throw new ArgumentOutOfRangeException(nameof(value)) : "ok";
        }
        catch (ArgumentOutOfRangeException) when (value < -10)
        {
            return "far below";
        }
        catch (ArgumentOutOfRangeException)
        {
            return "below";
        }
        finally
        {
            GC.KeepAlive(value);
        }
    }

    public static void Main(string[] args)
    {
        var seconds = args.Length > 0 && int.TryParse(args[0], out var parsed) ? parsed : 180;

        // Warm up so the methods are compiled and not still sitting on a call counter.
        long sum = 0;
        for (var index = 0; index < 200_000; index++)
        {
            sum += Add(index, index + 1);
            Describe(index % 20);
        }

        Total(new[] { 1, 2, 3 });
        Console.WriteLine($"ready {sum}");
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
    }
}
