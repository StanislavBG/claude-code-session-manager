Use system fonts through text styles (.body, .headline, .title) so every label scales with Dynamic Type; never hard-code point sizes.
Test layouts at the largest accessibility text sizes; let text wrap and stacks reflow instead of truncating.
Use SF Symbols before custom icons; match symbol weight and scale to adjacent text.
Use semantic system colors (Color.primary, .secondary, Color(.systemBackground), .tint) so the UI works in light and dark mode; never hard-code black or white.
Keep text and icon contrast at or above 4.5:1 in both appearances, and never convey state by color alone.
Give every tappable element a hit target of at least 44x44 pt, even when the visible glyph is smaller.
Keep content and controls inside the safe areas; only backgrounds may extend edge to edge.
Use standard controls (NavigationStack, TabView, List, Toggle, Button, Menu, sheets) before building custom ones.
Apply Liquid Glass only to the navigation and control layer that floats above content: bars, tab bars, toolbars, floating buttons.
Never put Liquid Glass on content such as list rows, cards, or media, and never stack glass on glass.
Tint glass sparingly, only for the one primary action on screen; leave other glass controls untinted.
Make corner radii concentric with the container: inner radius equals outer radius minus the padding between them.
Honor Reduce Transparency by replacing glass and blur with opaque fills, and honor Reduce Motion by replacing movement with fades.
Give every icon-only control an accessibility label, and keep VoiceOver order matching visual order.
