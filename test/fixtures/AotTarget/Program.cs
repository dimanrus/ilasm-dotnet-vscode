using AotTarget;

var values = new[] { 1, -2, 3 };

Console.WriteLine($"add {Target.Add(1, 2)}");
Console.WriteLine($"sum {Target.Sum(values)}");
Console.WriteLine($"describe {Target.Describe(7)}");
Console.WriteLine($"divide {Target.Divide(9, 3)}");
