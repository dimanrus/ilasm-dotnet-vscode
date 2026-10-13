namespace FsTarget

/// <summary>
/// The F# fixture: a record, a module and a class, which is what an F# assembly looks like from the
/// outside. The viewer reads metadata rather than a language, so the IL, the machine code and the
/// map from one to the other have to come out the same as for a C# assembly; only the lines of the
/// source the PDB names are of another language.
/// </summary>
type Item =
    { Name: string
      Price: decimal
      Quantity: int }

module CatalogLogic =
    let total (items: Item list) =
        items |> List.sumBy (fun item -> item.Price * decimal item.Quantity)

    let describe (items: Item list) =
        match items with
        | [] -> "empty"
        | [ single ] -> sprintf "one item: %s" single.Name
        | many -> sprintf "%d items" many.Length

type Catalog(items: Item list) =
    member _.Count = items.Length

    member _.Total = CatalogLogic.total items

    member _.Describe = CatalogLogic.describe items

    member _.Cheapest =
        items |> List.minBy (fun item -> item.Price)
