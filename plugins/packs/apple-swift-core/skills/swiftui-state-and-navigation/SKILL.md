---
name: swiftui-state-and-navigation
description: >-
  Use when writing or changing SwiftUI views in an iOS app — choosing between
  @State, @Binding, @Bindable, @Environment and @Observable models, passing
  state between screens, or building navigation with NavigationStack,
  navigationDestination, sheets and programmatic paths. Not for non-Swift code.
paths: ['**/*.swift']
---

# SwiftUI state and navigation

Pick the smallest owner for each piece of state, and drive navigation from data.

## Who owns the state

| Need | Use |
| --- | --- |
| Value local to one view (toggle, text field) | `@State private var` |
| Child edits a parent's value | `@Binding` |
| Shared model object owned by a view | `@State private var model = Model()` with an `@Observable` class |
| Child needs bindings into an `@Observable` object | `@Bindable var model` |
| App-wide dependency (store, router, settings) | `.environment(model)` + `@Environment(Model.self)` |
| Small persisted preference | `@AppStorage("key")` |

### Do

```swift
@Observable @MainActor
final class CounterModel {
    var count = 0
    func increment() { count += 1 }
}

struct CounterView: View {
    @State private var model = CounterModel()
    var body: some View {
        Button("Count: \(model.count)") { model.increment() }
            .accessibilityLabel("Increment counter")
    }
}

#Preview { CounterView() }
```

### Don't

```swift
final class CounterModel: ObservableObject {   // legacy pattern
    @Published var count = 0
}
struct CounterView: View {
    @ObservedObject var model = CounterModel()  // re-created on every parent redraw
    var body: some View { Text("\(model.count)") }
}
```

Rules of thumb:

- Keep `@State` `private`; it belongs to the view that declares it.
- Create an `@Observable` model in exactly one place (`@State` or app entry) and pass it down.
- Use `@Bindable` only when you need `$model.field` bindings; plain `let model` is enough to read.
- Don't copy model values into `@State` in `init` — it silently stops tracking the source.
- Derive values with computed properties instead of storing duplicates that drift.

## Navigation

Use one `NavigationStack` per navigation hierarchy, at the root of the tab or
scene, and drive it with values.

### Do

```swift
enum Route: Hashable {
    case detail(Item.ID)
    case settings
}

@Observable @MainActor
final class Router {
    var path: [Route] = []
    func show(_ route: Route) { path.append(route) }
    func popToRoot() { path.removeAll() }
}

struct RootView: View {
    @State private var router = Router()
    var body: some View {
        NavigationStack(path: $router.path) {
            ItemList()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .detail(let id): ItemDetail(id: id)
                    case .settings: SettingsView()
                    }
                }
        }
        .environment(router)
    }
}

struct ItemRow: View {
    let item: Item
    var body: some View {
        NavigationLink(value: Route.detail(item.id)) { Text(item.title) }
    }
}
```

### Don't

```swift
NavigationView {                               // deprecated
    List(items) { item in
        NavigationLink(destination: ItemDetail(item: item)) {  // builds every destination eagerly
            Text(item.title)
        }
    }
}
```

Rules of thumb:

- Never use `NavigationView`; use `NavigationStack`, or `NavigationSplitView` for sidebar layouts on iPad and Mac.
- Register `navigationDestination(for:)` once per value type, near the stack root, not inside a lazy row.
- Push identifiers (`Item.ID`) rather than whole mutable models, so deep links and state restoration work.
- Don't nest a `NavigationStack` inside another one; a pushed view inherits the parent stack.
- Present modals with `.sheet(item:)` bound to optional state; dismiss with `@Environment(\.dismiss)`.
- Keep tab selection in an enum: `TabView(selection: $tab)` with one `NavigationStack` inside each tab.

## Sheets

```swift
struct ItemList: View {
    @State private var editing: Item?
    var body: some View {
        List(items) { item in
            Button(item.title) { editing = item }
        }
        .sheet(item: $editing) { item in EditItemView(item: item) }
    }
}
```

Avoid a separate `isPresented` Bool plus a second optional for the same sheet —
the two drift apart and the sheet opens with stale data.

## Previews

Give each view a `#Preview` with sample data. For views that read the
environment, inject it in the preview:

```swift
#Preview {
    NavigationStack { ItemList() }
        .environment(Router())
}
```

## Checklist before you finish

- No `ObservableObject`, `@Published`, `@StateObject`, `@ObservedObject` in new code.
- No `NavigationView`; navigation is value-based.
- Each view has a `#Preview`; custom controls have `accessibilityLabel`.
- User-facing strings come from the String Catalog.
