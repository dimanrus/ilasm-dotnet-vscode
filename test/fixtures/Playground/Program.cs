using System.Globalization;

namespace Playground;

public static class Program
{
    public static async Task<int> Main()
    {
        var catalog = new Catalog("Instruments");
        catalog.Add(new Item("Violin", 1200m, 3));
        catalog.Add(new Item("Cello", 2400m, 1));
        catalog.Add(new Item("Flute", 350m, 7));

        PricingRule[] rules = [new BulkDiscount(), new SeasonalSurcharge(0.15m)];

        foreach (var rule in rules)
        {
            var total = catalog.Total(rule).ToString("0.00", CultureInfo.InvariantCulture);
            Console.WriteLine($"{rule.Describe()}: {total}");
        }

        foreach (var item in catalog.LowStock(2))
        {
            Console.WriteLine($"low stock: {item}");
        }

        Console.Write(catalog.Summarize());

        var importer = new Importer();
        var imported = await importer.ReadAsync<string>(["new-1", "new-2"]);
        Console.WriteLine($"imported {string.Join(", ", imported)}");

        // Runs the async iterator as well, so its state machine gets exercised too.
        await foreach (var streamed in importer.StreamAsync(2))
        {
            Console.WriteLine($"streamed {streamed.Name} worth {streamed.Value:0.00}");
        }

        return catalog.Count;
    }
}
