using System.Text.Json;
using System.Text.Json.Serialization;

namespace IlasmDotnet.Engine.Rpc;

/// <summary>Line delimited JSON-RPC 2.0 server over a pair of streams.</summary>
public sealed class JsonRpcServer
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly TextReader _input;
    private readonly TextWriter _output;

    public JsonRpcServer(TextReader input, TextWriter output)
    {
        _input = input;
        _output = output;
    }

    /// <summary>
    /// Reads requests until the stream ends or the dispatcher reports shutdown.
    /// The dispatcher returns the result payload and throws to signal an error.
    /// </summary>
    public void Run(Func<string, JsonElement?, object?> dispatch, string shutdownMethod = "shutdown")
    {
        string? line;
        while ((line = _input.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(line);
            }
            catch (JsonException ex)
            {
                Log($"ignoring malformed request: {ex.Message}");
                continue;
            }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("method", out var methodElement) ||
                    methodElement.ValueKind != JsonValueKind.String)
                {
                    Log("ignoring request without a method");
                    continue;
                }

                var method = methodElement.GetString()!;
                var hasId = root.TryGetProperty("id", out var id);
                var idValue = hasId ? id.Clone() : default;
                JsonElement? parameters = root.TryGetProperty("params", out var prm) && prm.ValueKind == JsonValueKind.Object
                    ? prm.Clone()
                    : null;

                object? result;
                try
                {
                    result = dispatch(method, parameters);
                }
                catch (Exception ex)
                {
                    Log($"{method} failed: {ex}");
                    if (hasId)
                    {
                        WriteError(idValue, ex);
                    }

                    continue;
                }

                if (hasId)
                {
                    WriteResult(idValue, result);
                }

                if (method == shutdownMethod)
                {
                    return;
                }
            }
        }
    }

    private void WriteResult(JsonElement id, object? result)
    {
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["result"] = result,
        }, JsonOptions);

        Write(payload);
    }

    private void WriteError(JsonElement id, Exception exception)
    {
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["error"] = new Dictionary<string, object?>
            {
                ["code"] = -32603,
                ["message"] = exception.Message,
                ["data"] = exception.GetType().FullName,
            },
        }, JsonOptions);

        Write(payload);
    }

    private void Write(string payload)
    {
        _output.Write(payload);
        _output.Write('\n');
        _output.Flush();
    }

    private static void Log(string message) => Console.Error.WriteLine($"[engine] {message}");
}
