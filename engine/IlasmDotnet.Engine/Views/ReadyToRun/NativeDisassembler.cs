using Gee.External.Capstone;
using Gee.External.Capstone.Arm64;
using Iced.Intel;

namespace IlasmDotnet.Engine.Views.ReadyToRun;

/// <summary>One decoded instruction: its address, its text and its length.</summary>
public sealed record DecodedInstruction(ulong Address, string Text, int Length);

/// <summary>
/// Turns the bytes of a code block into instructions for the architecture the image was built for,
/// which is not necessarily the one the viewer runs on.
///
/// x64 goes through Iced, the decoder the live route already uses, so both routes print instructions
/// the same way. arm64 goes through Capstone, which is what makes an arm64 image readable from an x64
/// machine — the case a live process can never cover without an arm64 host.
/// </summary>
public static class NativeDisassembler
{
    public static bool IsSupported(ImageArchitecture architecture) => architecture is ImageArchitecture.X64 or ImageArchitecture.Arm64;

    public static string Name(ImageArchitecture architecture) => architecture switch
    {
        ImageArchitecture.X64 => "x64",
        ImageArchitecture.Arm64 => "arm64",
        _ => "unknown",
    };

    public static IReadOnlyList<DecodedInstruction> Decode(ImageArchitecture architecture, byte[] code, ulong baseAddress)
        => architecture switch
        {
            ImageArchitecture.X64 => DecodeX64(code, baseAddress),
            ImageArchitecture.Arm64 => DecodeArm64(code, baseAddress),
            _ => [],
        };

    private static List<DecodedInstruction> DecodeX64(byte[] code, ulong baseAddress)
    {
        var decoder = Decoder.Create(64, new ByteArrayCodeReader(code));
        decoder.IP = baseAddress;
        var formatter = new IntelFormatter();
        var output = new StringOutput();
        var result = new List<DecodedInstruction>();

        while (decoder.IP < baseAddress + (ulong)code.Length)
        {
            var instruction = decoder.Decode();
            if (instruction.IsInvalid)
            {
                break;
            }

            output.Reset();
            formatter.Format(instruction, output);
            result.Add(new DecodedInstruction(instruction.IP, output.ToString(), instruction.Length));
        }

        return result;
    }

    private static List<DecodedInstruction> DecodeArm64(byte[] code, ulong baseAddress)
    {
        var result = new List<DecodedInstruction>();
        using var disassembler = CapstoneDisassembler.CreateArm64Disassembler(Arm64DisassembleMode.Arm);

        foreach (var instruction in disassembler.Disassemble(code, (long)baseAddress))
        {
            var text = instruction.Operand.Length > 0
                ? $"{instruction.Mnemonic} {instruction.Operand}"
                : instruction.Mnemonic;
            result.Add(new DecodedInstruction((ulong)instruction.Address, text, instruction.Bytes.Length));
        }

        return result;
    }
}
