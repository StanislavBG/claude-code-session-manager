# Migrate to AGENTS.md

Move a project's instruction text from CLAUDE.md into AGENTS.md, and leave CLAUDE.md as a thin stub.

Each project migrates in its own Epic (Self, Burrow, Bilko and the rest). Never move another project's files from here.

Steps:

1. Run `git mv CLAUDE.md AGENTS.md`.
2. Write a new CLAUDE.md that contains the line `@AGENTS.md`.
3. Move any line that is true for Claude Code alone out of AGENTS.md and into CLAUDE.md, below the import.
4. Turn every `@`-import inside AGENTS.md into a markdown link. Other tools do not follow `@`-imports.
5. Repeat steps 1-4 in every scoped folder that has its own CLAUDE.md.
6. Count both files of each pair in any size budget.
7. Run the drift-check script: `node <skill base dir>/scripts/drift-check.cjs --root <repo>`.
