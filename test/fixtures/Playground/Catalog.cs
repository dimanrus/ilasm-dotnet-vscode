using System.Collections;
using System.Text;

namespace Playground;

public sealed record Item(string Name, decimal Price, int Stock)
{
    public decimal Value => Price * Stock;
}

public sealed class Catalog : IEnumerable<Item>
{
    private readonly List<Item> _items = new();

    public Catalog(string name) => Name = name;

    public string Name { get; }

    public int Count => _items.Count;

    public Item this[int index] => _items[index];

    public static Catalog Empty { get; } = new("empty");

    public Item? Find(string name)
    {
        foreach (var item in _items)
        {
            if (string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return item;
            }
        }

        return null;
    }

    public void Add(Item item)
    {
        ArgumentNullException.ThrowIfNull(item);

        try
        {
            _items.Add(item);
        }
        catch (InvalidOperationException ex)
        {
            throw new InvalidOperationException($"{Name} rejected {item.Name}", ex);
        }
    }

    public decimal Total(PricingRule rule)
    {
        decimal total = 0;

        foreach (var item in _items)
        {
            total += rule.Apply(item);
        }

        return total;
    }

    public IEnumerable<Item> LowStock(int threshold) =>
        _items.Where(item => item.Stock <= threshold).OrderBy(item => item.Stock);

    public string Summarize()
    {
        var builder = new StringBuilder();

        for (var index = 0; index < _items.Count; index++)
        {
            var kind = _items[index].Stock switch
            {
                0 => "out",
                < 3 => "low",
                < 10 => "ok",
                _ => "plenty",
            };

            builder.AppendLine($"{index + 1}. {_items[index].Name} [{kind}]");
        }

        return builder.ToString();
    }

    public IEnumerator<Item> GetEnumerator() => _items.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
