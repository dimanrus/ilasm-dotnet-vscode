namespace AotTarget;

/// <summary>
/// Work the viewer has to find in a native image: a method that is a leaf, one with a loop, one with
/// branches and one with a handler, so the disassembly has more than a single shape.
/// </summary>
public static class Target
{
    public static int Add(int left, int right) => left + right;

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

    public static string Describe(int value) => value switch
    {
        < 0 => "negative",
        0 => "zero",
        < 10 => "small",
        _ => "large",
    };

    public static int Divide(int left, int right)
    {
        try
        {
            return left / right;
        }
        catch (DivideByZeroException)
        {
            return -1;
        }
    }
}
