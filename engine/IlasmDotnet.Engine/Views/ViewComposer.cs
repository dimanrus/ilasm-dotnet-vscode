using System.Text;
using IlasmDotnet.Engine.Model;

namespace IlasmDotnet.Engine.Views;

/// <summary>Joins several single-target views into one, keeping every map block pointing at the right line.</summary>
internal static class ViewComposer
{
    public static ViewDto Merge(
        string title,
        string language,
        IReadOnlyList<ViewDto> parts,
        bool hasDebugInfo,
        IReadOnlyList<string>? notes = null)
    {
        var builder = new StringBuilder();
        var blocks = new List<MapBlock>();
        var offset = 0;

        foreach (var part in parts)
        {
            if (builder.Length > 0)
            {
                builder.Append('\n');
                offset++;
            }

            builder.Append(part.Text);
            foreach (var block in part.Blocks)
            {
                blocks.Add(block with
                {
                    TextStartLine = block.TextStartLine + offset,
                    TextEndLine = block.TextEndLine + offset,
                });
            }

            offset += LineWriter.CountLines(part.Text);
        }

        var collectedNotes = new List<string>();
        foreach (var part in parts)
        {
            if (part.Notes is not null)
            {
                collectedNotes.AddRange(part.Notes);
            }
        }

        if (notes is not null)
        {
            collectedNotes.AddRange(notes);
        }

        return new ViewDto(
            title,
            language,
            builder.ToString(),
            hasDebugInfo,
            blocks,
            collectedNotes.Count == 0 ? null : collectedNotes.Distinct().ToList());
    }
}
