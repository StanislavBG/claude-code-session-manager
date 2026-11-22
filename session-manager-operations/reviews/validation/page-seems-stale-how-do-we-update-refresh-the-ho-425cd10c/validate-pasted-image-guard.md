# Validation: pasted-image-degenerate-guard (PRD 3647)

Base: 7d9367046c96808d03df96fd7f3e35028b2b93da. Landed commit: 02991297 (touches only the two PRD files).

## pasted-image-degenerate-guard — VERIFIED

- AC1 `pngSize`: attachments.tsx exports it (~line 29); needs ≥24 bytes and the 8-byte signature, reads uint32 BE at 16 and 20 via DataView, else null.
- AC2 probe: `add` skips `hasRealPath` or non-`image/png` items. Others go to `probeDegeneratePng`, which reads `file.slice(0,24).arrayBuffer()`, and if w and h ≤ 2 (`DEGENERATE_PNG_MAX_PX`) calls `remove(item.id)` (revokes the blob URL) then `toast.warn("The pasted image is only W×H px — your screenshot did not reach the clipboard … Copy it again and paste.")`.
- AC3: a probe error returns early, so the item stays. Real-path, non-PNG and large PNGs are never removed. `add` stays synchronous (`void probe`). `mountedRef` guards post-unmount state.
- AC4 tests in attachments.test.tsx: pngSize 1×1, 640×480, non-PNG and truncated input; 1×1 paste → empty tray, warn once; 640×480 stays, no toast; real-path file never sliced.
- Gate re-run: vitest (2 files, 14 tests) pass; `npm run typecheck` exit 0; lint:hooks OK; lint:any OK.
- Combined diff reviewed by hand (code-review and security-review were not run as slash commands). It is a pure client-side read of 24 bytes, with no path, secret or injection surface, and no duplicated helper.

## Findings

- Critical: none.
- Important: none.
- Minor: none. The probe is only guarded by `itemsRef` membership, so an item the user removed before the probe settled is not toasted. That is correct behaviour.
