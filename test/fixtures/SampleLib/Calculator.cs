namespace SampleLib;

public sealed class Calculator
{
    private readonly List<int> _history = new();

    public int Add(int a, int b)
    {
        var result = a + b;
        _history.Add(result);
        return result;
    }

    public int Count => _history.Count;

    public string Describe(int value)
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

    public IEnumerable<int> Evens(int max)
    {
        for (var i = 0; i <= max; i++)
        {
            if (i % 2 == 0)
            {
                yield return i;
            }
        }
    }
}
