using System.Text;

namespace IlasmDotnet.Engine.Views;

/// <summary>Appends text while tracking 1-based line numbers, which the map blocks refer to.</summary>
internal sealed class LineWriter
{
    private readonly StringBuilder _builder = new();

    public int Line { get; private set; } = 1;

    public string Text => _builder.ToString();

    public void AppendLine(string text = "")
    {
        _builder.Append(text).Append('\n');
        Line++;
    }

    public void Append(string text)
    {
        _builder.Append(text);
        Line += CountLines(text);
    }

    /// <summary>Number of newline characters, which is how many lines the text advances by.</summary>
    public static int CountLines(string text)
    {
        var count = 0;
        foreach (var character in text)
        {
            if (character == '\n')
            {
                count++;
            }
        }

        return count;
    }
}
