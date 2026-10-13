namespace Playground;

public abstract class PricingRule
{
    public abstract decimal Apply(Item item);

    public virtual string Describe() => "pricing rule";

    public sealed override string ToString() => Describe();
}

public sealed class BulkDiscount : PricingRule
{
    private const decimal Threshold = 1000m;

    public override decimal Apply(Item item)
    {
        var value = item.Value;
        return value >= Threshold ? value * 0.9m : value;
    }

    public override string Describe() => "bulk discount";
}

public sealed class SeasonalSurcharge(decimal rate) : PricingRule
{
    public override decimal Apply(Item item) => item.Value * (1m + rate);

    public override string Describe() => $"seasonal +{rate:P0}";
}
