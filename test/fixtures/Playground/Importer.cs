namespace Playground;

public sealed class Importer
{
    public async Task<IReadOnlyList<T>> ReadAsync<T>(IEnumerable<string> codes, Func<string, T>? factory = null)
    {
        var results = new List<T>();
        factory ??= Create<T>;

        foreach (var code in codes)
        {
            // Yielding keeps this method async, so the compiler emits a state machine here.
            await Task.Yield();
            results.Add(factory(code));
        }

        return results;
    }

    public async IAsyncEnumerable<Item> StreamAsync(int count)
    {
        for (var index = 0; index < count; index++)
        {
            await Task.Delay(10);
            yield return new Item($"streamed-{index}", index * 10m, index);
        }
    }

    private static T Create<T>(string code) => typeof(T) == typeof(string)
        ? (T)(object)code.ToUpperInvariant()
        : throw new NotSupportedException($"cannot create {typeof(T).Name} from a code");
}
