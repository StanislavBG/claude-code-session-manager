---
name: hig-layout-and-accessibility
description: Use when laying out or reviewing SwiftUI iOS screens against the Human Interface Guidelines — typography and Dynamic Type, SF Symbols, semantic colors and dark mode, hit targets, safe areas, standard controls, VoiceOver labels, and Reduce Motion or Reduce Transparency support. Not for non-Swift code.
paths: ['**/*.swift']
---

# HIG layout and accessibility

A screen that follows the system conventions gets Dynamic Type, dark mode,
VoiceOver and right-to-left support mostly for free. Each rule below is about
not breaking that.

## Typography and Dynamic Type

Use text styles, never fixed sizes. For custom fonts, scale them relative to a
text style.

```swift
// Do
Text(title).font(.headline)
Text(body).font(.body)
Text(price).font(.custom("Brand", size: 17, relativeTo: .body))

// Don't — ignores the user's text size
Text(title).font(.system(size: 17, weight: .semibold))
```

Let layouts reflow at accessibility sizes instead of truncating:

```swift
@Environment(\.dynamicTypeSize) private var typeSize

let layout = typeSize.isAccessibilitySize
    ? AnyLayout(VStackLayout(alignment: .leading))
    : AnyLayout(HStackLayout())
layout { Label("Due", systemImage: "calendar"); Text(date) }
```

Scale fixed spacing and image sizes with `@ScaledMetric`.

## Icons: SF Symbols first

```swift
// Do — scales with text, adapts weight, supports variants
Label("Favorites", systemImage: "heart.fill")
Image(systemName: "bell.badge").symbolRenderingMode(.hierarchical)

// Don't — a fixed-size bitmap that ignores Dynamic Type
Image("heart_icon_24").resizable().frame(width: 24, height: 24)
```

Draw a custom icon only when no symbol fits, and export it as a custom symbol.

## Color and dark mode

```swift
// Do
.foregroundStyle(.primary)
.foregroundStyle(.secondary)
.background(Color(.systemGroupedBackground))
.tint(.accentColor)

// Don't — invisible or harsh in one of the two appearances
.foregroundColor(.black)
.background(Color(red: 1, green: 1, blue: 1))
```

Brand colors go in the asset catalog with light, dark and high-contrast
variants. Never show state with color alone — pair it with a symbol or text.

## Hit targets

Every tappable element needs at least 44x44 pt, even if the glyph is smaller.

```swift
// Do
Button { close() } label: {
    Image(systemName: "xmark")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
}
.accessibilityLabel("Close")

// Don't — a 16 pt target that is hard to hit
Image(systemName: "xmark").onTapGesture { close() }
```

Prefer `Button` over `onTapGesture`: it brings the button trait, focus,
keyboard and pointer support.

## Safe areas and layout

Content and controls stay inside the safe area; only backgrounds bleed.

```swift
// Do
VStack { Header(); Content() }
    .background(Color(.systemBackground).ignoresSafeArea())

// Don't — buttons slide under the Dynamic Island and home indicator
VStack { Header(); Content() }.ignoresSafeArea()
```

Use `safeAreaInset(edge:)` for bars you add yourself, and system margins
(`.padding()`, `.scenePadding()`, `.contentMargins`) instead of magic numbers.
Use leading/trailing, never left/right, so right-to-left languages flip.

## Standard controls first

`NavigationStack`, `TabView`, `List`, `Form`, `Toggle`, `Picker`, `Menu`,
`.sheet`, `.confirmationDialog`, `.searchable` — each already handles
accessibility, keyboard, dark mode and the current design. Build a custom
control only when no standard one expresses the interaction, and then give it
the matching accessibility traits.

```swift
// Do
Toggle("Notifications", isOn: $notify)

// Don't — a hand-rolled switch VoiceOver cannot operate
HStack { Text("Notifications"); Capsule().fill(notify ? .green : .gray) }
    .onTapGesture { notify.toggle() }
```

## VoiceOver

- Give every icon-only control an `.accessibilityLabel`.
- Group a composite row with `.accessibilityElement(children: .combine)`.
- Hide pure decoration with `.accessibilityHidden(true)`.
- Keep the reading order equal to the visual order.

## Reduce Motion and Reduce Transparency

```swift
@Environment(\.accessibilityReduceMotion) private var reduceMotion
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

.transition(reduceMotion ? .opacity : .move(edge: .bottom))
.background(reduceTransparency ? AnyShapeStyle(Color(.systemBackground))
                               : AnyShapeStyle(.regularMaterial))
```

## Review checklist

- [ ] No fixed font sizes; layout checked at the largest accessibility size.
- [ ] SF Symbols used wherever one fits.
- [ ] Only semantic or asset-catalog colors; checked in light and dark.
- [ ] Every tap target at least 44x44 pt.
- [ ] Controls inside the safe area.
- [ ] Standard controls unless none fits.
- [ ] Icon-only controls labeled; VoiceOver order matches the screen.
- [ ] Reduce Motion and Reduce Transparency honored.
