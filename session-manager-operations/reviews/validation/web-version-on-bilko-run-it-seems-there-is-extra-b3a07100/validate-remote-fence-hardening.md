# Validation: remote-fence-home-root-and-credential-stores (PRD 2343)

Base: 4c93a429 (known). Commit for the PRD: `430a12ff` (touches only `remoteIpcDispatch.cjs` + its test, matching `# Files`). PRD file: `prds-archived/2343-remote-fence-home-root-and-credential-stores.md`.

## remote-fence-home-root-and-credential-stores — VERIFIED

| Criterion | Evidence |
| --- | --- |
| Home/ancestor roots ignored for `mode:'root'`; `files:list` of home still works | `remoteIpcDispatch.cjs:109-111` `if (isContainedIn(home, realRoot, platform)) continue`; `allowHomeListing` branch unchanged at :102-104. Probe: root `H`, `H/`, `/`, `H/proj/..` all refuse `H/notes.txt`; `files:list H/` with no roots → ok. |
| Deny set extended, consecutive-segment match, raw + realpath, case-insensitive on win32 | `SECRET_DIRS` :50 (`.password-store .azure .terraform.d`), `SECRET_BASENAMES` :51 (`.claude.json .git-credentials .pypirc`), `SECRET_SEQUENCES` :54-65 (all 10 multi-segment entries incl. `.claude/session-manager`, `.config/gh`, `.config/git/credentials`, `.cargo/credentials[.toml]`, `.local/share/keyrings`, `Library/Keychains`, both `AppData/*/Microsoft/Credentials`); matched at any depth via `segs[i+k]`; `isSecretPath(raw)||isSecretPath(real)` :99; win32 lower-cases both sides :70-72. |
| Tests added | `git show 430a12ff --stat`: test file +60 lines (home root, `/` root, win32 drive root, real root, files:list home, per-entry refusals, win32 upper-case, near-miss, symlink into `~/.claude/session-manager`). All pass (below). |
| Electron IPC path unchanged | `git diff 4c93a429..HEAD --stat -- src/main/lib/feedback-remote` = only the two files; `remoteArgFence` is called only from `createRemoteIpcDispatcher` (:163-164). |

Gate re-run (`timeout 300 npx vitest run remoteIpcDispatch web-remote apiSurface && timeout 300 npm run typecheck`): 16 files / 179 tests passed; `tsc --noEmit` for both tsconfigs exit 0.

## Own bypass attempts (probe against real fs on Linux; win32 via `path.win32.resolve` as realpath)

Fixture: home `/tmp/vh/home` with `.claude/session-manager/web-remote.json`, `.config/gh/hosts.yml`, `notes.txt`, `proj/a.txt`.

1. **Trailing separator** — all fenced as expected:
   - home root `H/` → read `H/notes.txt`: refused. `/` root: refused. Real root `H/proj/` reads `a.txt`: ok.
   - `files:list H/.claude/session-manager/`: refused. `H/.config//gh//hosts.yml` (dup seps): refused. `files:list H/`: ok.
   - win32: root `C:\Users\Bob\` and `C:\\`: refused.
2. **Mixed case on win32** — fenced:
   - `.CLAUDE\Session-Manager\…`, `APPDATA\ROAMING\microsoft\CREDENTIALS\x`, `.Config\GH` with mixed `/` `\`: refused.
   - Home root registered as `c:\USERS\bob`, drive root `c:\`: refused. Real root `c:\users\BOB\Proj` still reads own file: ok.
3. **`..` segments** — fenced:
   - `H/proj/../notes.txt` via proj root: refused (realpath collapses). `H/proj/../.claude/session-manager/web-remote.json` and `…/.claude/x/../session-manager/…`: refused. Root given as `H/proj/..` (== home): ignored, refused. Nonexistent target with `..` (realpath throws): refused (fail-closed).

No bypass of the three requested classes found.

## Findings

### Critical
- none

### Important
- none

### Minor
- `src/main/index.cjs:136` — production `fenceCtx.realpath` is `fs.realpathSync` (JS impl, not `.native`). On Windows it does not expand 8.3 short names (my probe: `proj\CLAUDE~1\SESSIO~1\web-remote.json` → ok under a lexical realpath) or normalise trailing dot/space (`.claude.json.` → ok under lexical realpath). I could not run on Windows, so exploitability is unconfirmed; `fs.realpathSync.native` (as `insideHome.cjs` `realpath` uses) would close it. Out of this PRD's files; suggest a follow-up.
- Deny matching is name-based, so a secret reached through a hardlink or a non-secret-named copy inside a project root is not caught (inherent to the design; root confinement still applies).
- `/code-review` and `/security-review` were not run as separate tools; I self-reviewed the 430a12ff diff: no new input-handling holes, no duplicated helper (reuses `isContainedIn`), no secrets.
