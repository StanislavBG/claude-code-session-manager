---
name: swift-concurrency
description: >-
  Use when writing or fixing asynchronous Swift code in an iOS app — async/await,
  Task and TaskGroup, actors, @MainActor isolation, Sendable conformance, or
  Swift 6 strict-concurrency compiler errors such as data-race and
  non-Sendable warnings. Not for non-Swift code.
paths: ['**/*.swift']
---

# Swift concurrency (Swift 6)

Make isolation explicit, keep work structured, and let the compiler prove there
are no data races.

## Isolation basics

- UI state and view models are `@MainActor`.
- Shared mutable state that is not UI lives in an `actor`.
- Values passed between isolation domains are `Sendable` (structs/enums of Sendable fields are automatic).
- `nonisolated` marks members that touch no isolated state.

### Do

```swift
struct Article: Sendable, Identifiable, Decodable {
    let id: Int
    let title: String
}

actor ArticleCache {
    private var byID: [Int: Article] = [:]
    func store(_ items: [Article]) { for a in items { byID[a.id] = a } }
    func article(_ id: Int) -> Article? { byID[id] }
}

@Observable @MainActor
final class FeedModel {
    private(set) var articles: [Article] = []
    private(set) var error: String?
    private let client: APIClient

    init(client: APIClient) { self.client = client }

    func load() async {
        do {
            articles = try await client.articles()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
```

### Don't

```swift
final class FeedModel {
    var articles: [Article] = []               // mutated from any thread
    func load() {
        DispatchQueue.global().async {
            let data = try! Data(contentsOf: url)   // blocking + force try
            self.articles = decode(data)            // data race, off main thread
        }
    }
}
```

## Starting work from SwiftUI

Prefer the `.task` modifier: it runs on appear and is cancelled on disappear.

```swift
struct FeedView: View {
    @State private var model: FeedModel
    var body: some View {
        List(model.articles) { Text($0.title) }
            .task { await model.load() }
            .refreshable { await model.load() }
    }
}
```

Use `.task(id:)` to restart work when an input changes (for example a search
query). Avoid a bare `Task { }` in `onAppear` — nothing cancels it.

## Structured concurrency

Run independent work in parallel with `async let` or a task group; children are
cancelled automatically when the parent ends or throws.

### Do

```swift
func dashboard() async throws -> Dashboard {
    async let profile = client.profile()
    async let stats = client.stats()
    return try await Dashboard(profile: profile, stats: stats)
}

func thumbnails(for ids: [Int]) async throws -> [Int: Image] {
    try await withThrowingTaskGroup(of: (Int, Image).self) { group in
        for id in ids { group.addTask { (id, try await client.thumbnail(id)) } }
        var result: [Int: Image] = [:]
        for try await (id, image) in group { result[id] = image }
        return result
    }
}
```

### Don't

```swift
for id in ids {
    Task { images[id] = try? await client.thumbnail(id) }  // unstructured, racy, errors dropped
}
```

## Wrapping callback APIs

Bridge a completion-handler API once, with a checked continuation, and resume
it exactly once on every path.

```swift
func currentLocation() async throws -> CLLocation {
    try await withCheckedThrowingContinuation { continuation in
        locator.requestOnce { result in
            continuation.resume(with: result)
        }
    }
}
```

For streams of values, wrap the delegate or callback in an `AsyncStream` and
consume it with `for await`.

## Cancellation

- Check `try Task.checkCancellation()` or `Task.isCancelled` inside long loops.
- Don't swallow `CancellationError` as a user-visible failure.
- Keep a `Task` handle only when you must cancel it manually; store it and call `cancel()` in teardown.

## Fixing strict-concurrency errors

| Compiler says | Usual fix |
| --- | --- |
| "Main actor-isolated property … from a nonisolated context" | Mark the caller `@MainActor`, or `await` the access. |
| "Type … does not conform to Sendable" | Make it a value type with Sendable fields, an `actor`, or `@MainActor`-isolate the class. |
| "Capture of non-Sendable … in a @Sendable closure" | Copy the needed values into `let`s first, or keep the work on one actor. |
| "Sending … risks causing data races" | Don't use the value after handing it to another task; pass a copy. |

Reach for `@unchecked Sendable` or `nonisolated(unsafe)` only when the type is
truly protected by a lock you own, and leave a comment saying which lock.

## Checklist before you finish

- No new `DispatchQueue`, completion handlers, or `try!`.
- Every UI-facing type is `@MainActor`; cross-boundary types are `Sendable`.
- Async work from views uses `.task`; parallel work uses `async let` or a task group.
- The project builds with no concurrency warnings in Swift 6 mode.
