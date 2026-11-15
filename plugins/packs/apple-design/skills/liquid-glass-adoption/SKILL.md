---
name: liquid-glass-adoption
description: Use when adding, reviewing or fixing Liquid Glass in a SwiftUI iOS app — glassEffect, GlassEffectContainer, glass button styles, tinted glass, toolbars and tab bars that float over content, or migrating custom blur/material chrome to the iOS 26 design. Not for non-Swift code.
paths: ['**/*.swift']
---

# Liquid Glass adoption

Liquid Glass is a material for the **control layer**: the navigation and
controls that float above the content. Content stays opaque and readable
underneath; glass lets it show through the chrome.

## 1. Let the system do it first

Standard containers adopt glass on their own when built with the current SDK:
`NavigationStack` bars, `TabView` tab bars, `.toolbar` items, sheets, menus,
and `Button` styles. Before writing any `glassEffect`, remove custom
backgrounds you added to those containers — they hide the system glass.

```swift
// Don't — paints over the system bar material
.toolbarBackground(Color.white, for: .navigationBar)
.background(.ultraThinMaterial)

// Do — keep standard chrome, let the system render glass
NavigationStack {
    List(items) { ItemRow(item: $0) }
        .navigationTitle("Library")
        .toolbar { ToolbarItem { Button("Add", systemImage: "plus") { add() } } }
}
```

## 2. Custom floating controls

Use `glassEffect` only for a control that floats over content and has no
standard equivalent.

```swift
// Do — one floating control, glass in a capsule
Button { record() } label: { Label("Record", systemImage: "mic.fill") }
    .padding()
    .glassEffect(.regular.interactive(), in: .capsule)

// Don't — glass on content
ForEach(photos) { photo in
    PhotoCard(photo: photo)
        .glassEffect()          // cards are content, keep them opaque
}
```

## 3. Never glass on glass

Glass cannot sample other glass. When several glass controls sit together,
wrap them in one `GlassEffectContainer` so they render as one surface and can
merge and morph.

```swift
// Do
GlassEffectContainer(spacing: 12) {
    HStack(spacing: 12) {
        Button("Undo", systemImage: "arrow.uturn.backward") { undo() }
            .glassEffect()
        Button("Redo", systemImage: "arrow.uturn.forward") { redo() }
            .glassEffect()
    }
}

// Don't — a glass button inside a glass panel
VStack { Button("Done") { } .glassEffect() }
    .padding()
    .glassEffect(in: .rect(cornerRadius: 24))
```

To animate controls appearing or merging, give each one a
`glassEffectID(_:in:)` with a shared `@Namespace` inside the container.

## 4. Tint for the primary action only

Tint means "this is the main thing to do here". One tinted control per screen
is the norm; tinting everything removes the signal.

```swift
// Do
Button("Checkout") { checkout() }
    .buttonStyle(.glassProminent)
    .tint(.accentColor)
Button("Save for later") { save() }
    .buttonStyle(.glass)

// Don't — every control shouts
Button("Share") { }.glassEffect(.regular.tint(.blue))
Button("Edit") { }.glassEffect(.regular.tint(.orange))
```

## 5. Shapes and spacing

- Prefer `.capsule` and `.circle` for small controls.
- For rectangles, make the radius concentric with what contains it: inner
  radius = outer radius − padding. `ConcentricRectangle` or
  `.rect(cornerRadius:)` computed from the container both work.
- Keep glass controls clear of content they would obscure; use
  `safeAreaInset(edge:)` so scroll content can scroll under them but still
  reach the end.

```swift
// Do — content scrolls under the floating bar and stays reachable
ScrollView { Feed() }
    .safeAreaInset(edge: .bottom) { ComposerBar().glassEffect(in: .capsule) }
```

## 6. Accessibility

Glass already adapts to Reduce Transparency and Increase Contrast when you use
system APIs. For custom fills you draw yourself, check the environment:

```swift
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

.background(reduceTransparency ? Color(.secondarySystemBackground) : .clear)
```

Under Reduce Motion, skip morph animations and use a plain fade:
`withAnimation(reduceMotion ? .easeInOut : .bouncy) { … }`.

## Review checklist

- [ ] No glass on rows, cards, images or text blocks.
- [ ] No glass nested inside glass; grouped glass lives in one container.
- [ ] At most one tinted / prominent glass control per screen.
- [ ] Custom bar backgrounds removed from standard containers.
- [ ] Corner radii concentric with the container.
- [ ] Checked with Reduce Transparency, Increase Contrast and Reduce Motion on.
