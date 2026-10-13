module FsTarget.Program

open FsTarget

[<EntryPoint>]
let main _ =
    let items =
        [ { Name = "pen"; Price = 2.5M; Quantity = 3 }
          { Name = "book"; Price = 12.0M; Quantity = 1 } ]

    let catalog = Catalog(items)
    printfn "ready %d %M %s" catalog.Count catalog.Total catalog.Describe
    System.Threading.Thread.Sleep(90_000)
    0
