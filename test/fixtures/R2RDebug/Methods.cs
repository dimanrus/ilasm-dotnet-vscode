namespace R2RDebug;

/// <summary>
/// Methods whose shape makes the map from an instruction to the IL it implements worth reading: a
/// loop, a switch, a call and an exception handler all turn into code the compiler is free to
/// reorder. Published with ReadyToRun, the image carries that map, and the tests compare it with the
/// listing the viewer produces from the file alone.
/// </summary>
public static class Methods
{
    public static int Sum(int[] values)
    {
        var total = 0;
        foreach (var value in values)
        {
            if (value > 0)
            {
                total += value;
            }
        }

        return total;
    }

    public static string Grade(int score) => score switch
    {
        >= 90 => "A",
        >= 75 => "B",
        >= 50 => "C",
        _ => "F",
    };

    public static int Countdown(int from)
    {
        var steps = 0;
        while (from > 0)
        {
            from--;
            steps++;
        }

        return steps;
    }

    public static void Main(string[] args)
    {
        var seconds = args.Length > 0 && int.TryParse(args[0], out var parsed) ? parsed : 180;

        // Warm up so the methods are compiled and not still sitting on a call counter.
        var values = new[] { 3, -1, 7, 0, 12 };
        long sum = 0;
        for (var index = 0; index < 100_000; index++)
        {
            sum += Sum(values) + Countdown(index % 7) + Grade(index % 100).Length;
        }

        Console.WriteLine($"ready {sum}");
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
    }
}
