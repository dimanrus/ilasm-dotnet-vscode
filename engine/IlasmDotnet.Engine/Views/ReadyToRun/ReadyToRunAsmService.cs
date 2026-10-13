using System.Reflection.Metadata;
using IlasmDotnet.Engine.Metadata;
using IlasmDotnet.Engine.Model;
using IlasmDotnet.Engine.Views;

namespace IlasmDotnet.Engine.Views.ReadyToRun;

/// <summary>
/// Produces the native ASM view of a ReadyToRun image by reading the code the compiler stored in the
/// file. Nothing is executed and no process is needed, which is the difference to the two other
/// routes: the JIT harness compiles the methods again on this machine, and the live route reads a
/// running process.
///
/// What the image adds to the listing is the map from an instruction to the IL instruction it
/// implements, which the compiler wrote for a debugger. Reading it makes the listing of a file as
/// exact as the listing of a running process, and it links every instruction to its IL and to the line
/// of source the PDB attributes to that IL. Images whose map uses an encoding this reader does not know
/// are still listed, with a block per method rather than per instruction.
/// </summary>
public static class ReadyToRunAsmService
{
    private const int MaxMethods = 200;

    /// <summary>
    /// Outcome of reading an image: the listing, or the reason why the file's own code could not be
    /// used. The reason is null when the file is simply not a ReadyToRun image, in which case
    /// compiling the methods on this machine is the right answer and needs no explanation.
    /// </summary>
    public readonly record struct ImageAsm(ViewDto? View, string? Note);

    /// <summary>
    /// The place the code at an offset within a block implements: the map is sorted by the offset of
    /// the code, so the last place that starts at or before it is the one that holds.
    /// </summary>
    private static ImageMapping? MappingAt(IReadOnlyList<ImageMapping>? map, int offset)
    {
        if (map is null || map.Count == 0 || offset < 0)
        {
            return null;
        }

        var found = map[0];
        foreach (var mapping in map)
        {
            if (mapping.NativeOffset > offset)
            {
                break;
            }

            found = mapping;
        }

        return found.NativeOffset <= offset ? found : null;
    }

    public static ImageAsm Build(AssemblyEntry entry, IReadOnlyList<MethodDefinitionHandle> methods, string title)
    {
        var file = Path.GetFileName(entry.Path);
        // The image to read is the assembly itself, which for a single file application is the one
        // taken out of the bundle rather than the executable that was opened.
        var image = ReadyToRunImage.TryLoad(entry.ReadablePath, out var loadNote);
        if (image is null)
        {
            return new ImageAsm(null, loadNote);
        }

        if (!NativeDisassembler.IsSupported(image.Architecture))
        {
            return new ImageAsm(
                null,
                $"{file} carries ReadyToRun code for {image.ArchitectureName}, which this build cannot disassemble (x64 and arm64 only).");
        }

        if (!image.HasRuntimeFunctions)
        {
            return new ImageAsm(null, loadNote);
        }

        var architecture = NativeDisassembler.Name(image.Architecture);
        var text = new LineWriter();
        var blocks = new List<MapBlock>();
        var notes = new List<string>();

        text.AppendLine($"; Native code of {title} (read from the image)");
        text.AppendLine($"; ReadyToRun {architecture} code, compiled ahead of time by the toolchain, version {image.MajorVersion}.{image.MinorVersion}");

        var selected = methods.Take(MaxMethods).ToList();
        if (methods.Count > selected.Count)
        {
            notes.Add($"Only the first {MaxMethods} methods of {methods.Count} are listed.");
        }

        var withCode = 0;
        var mapped = 0;
        var unmapped = 0;

        foreach (var method in selected)
        {
            var token = AssemblyEntry.TokenOf(method);
            var signature = entry.GetMemberSignature(method);
            var startLine = text.Line;
            var code = image.CodeFor(method);

            text.AppendLine();
            text.AppendLine($"; ── {signature}");

            if (code.Count == 0)
            {
                // Not every method is precompiled: the toolchain leaves methods it does not consider
                // worth compiling to the JIT, and inlines others into their callers.
                notes.Add($"{signature} — the image has no code for this method.");
                text.AppendLine("; the image has no code for this method: the toolchain either left it to the JIT or inlined it into a caller.");
                text.AppendLine("; attach to a running process to see the code the JIT produced for it.");
                blocks.Add(new MapBlock(token, 0, entry.GetMethodBodySize(token), startLine, text.Line - 1, null, 0, 0));
                continue;
            }

            withCode++;
            var total = code.Sum(block => block.Size);
            text.AppendLine($"; {total} bytes of code at 0x{code[0].StartRva:x}");

            var lines = new List<(int Line, ImageMapping Mapping, int Token)>();
            var anyMap = false;

            foreach (var block in code)
            {
                if (block.IsAdjacent)
                {
                    text.AppendLine($"; ── further code of the same method (funclet or cold part), {block.Size} bytes at 0x{block.StartRva:x}");
                }

                var map = image.IlMapFor(block, out var mapNote);
                if (mapNote is not null)
                {
                    notes.Add($"{signature} — {mapNote}");
                }

                if (map is { Count: > 0 })
                {
                    anyMap = true;
                }

                foreach (var instruction in NativeDisassembler.Decode(image.Architecture, image.Read(block.StartRva, block.Size), (ulong)block.StartRva))
                {
                    var mapping = MappingAt(map, (int)instruction.Address - block.StartRva);
                    if (mapping is null)
                    {
                        text.AppendLine($"        {instruction.Text}");
                        continue;
                    }

                    text.AppendLine($"        {instruction.Text,-52} ; {mapping.Value.Label}");
                    if (mapping.Value.IlOffset >= 0)
                    {
                        lines.Add((text.Line - 1, mapping.Value, token));
                    }
                }
            }

            if (anyMap)
            {
                mapped++;

                // Every instruction that stands for an instruction of the method becomes a block of its
                // own, which is what links the listing to the IL pane and to the line of source: a block
                // that covered the whole method would leave both to a search.
                foreach (var (line, mapping, owner) in lines)
                {
                    var source = IlViewService.ResolveSource(entry, owner, mapping.IlOffset);
                    blocks.Add(new MapBlock(
                        owner,
                        mapping.IlOffset,
                        mapping.IlOffset + 1,
                        line,
                        line,
                        source.File,
                        source.StartLine,
                        source.EndLine));
                }
            }
            else
            {
                unmapped++;
                blocks.Add(new MapBlock(token, 0, entry.GetMethodBodySize(token), startLine, text.Line - 1, null, 0, 0));
            }
        }

        text.AppendLine(mapped == 0
            ? "; The image does not say which IL instruction an instruction implements, so each block covers a whole method. Attach to a running process for the exact instruction."
            : unmapped == 0
                ? "; Every instruction is followed by the IL instruction it implements, as the image records it for a debugger."
                : "; Instructions are followed by the IL instruction they implement where the image says so; the methods without such a map are listed per method.");

        if (withCode == 0)
        {
            return new ImageAsm(
                null,
                $"{file} is a ReadyToRun image, but it holds no code for the methods asked for: the toolchain left them to the JIT or inlined them into a caller.");
        }

        var distinct = notes.Distinct().ToList();
        return new ImageAsm(
            new ViewDto(
                $"{title} (ASM, from the image)",
                "il-asm",
                text.Text,
                entry.Pdb is not null,
                blocks,
                distinct.Count == 0 ? null : distinct),
            null);
    }
}
