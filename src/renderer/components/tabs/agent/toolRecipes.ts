export type GagType =
  | 'spark' | 'flip' | 'scribble' | 'glow' | 'fan' | 'orbit'
  | 'tick' | 'boot' | 'sparkle' | 'unfurl' | 'puff' | 'spin'

export type DestinationType = 'bench' | 'kanban' | 'dock' | 'whiteboard' | 'conveyor' | 'sky' | 'floor'

export interface ToolRecipe {
  glyph: string
  glyphChar: string    // single character rendered on conveyor crates
  destination: DestinationType
  arcHeight: number    // px — peak of flight arc above midpoint
  durationMs: number   // total fly + gag time
  gag: GagType
}

export const TOOL_RECIPES: Record<string, ToolRecipe> = {
  Bash:         { glyph: '🔧', glyphChar: '$', destination: 'conveyor',  arcHeight: 100, durationMs: 1200, gag: 'spark'   },
  Read:         { glyph: '📖', glyphChar: 'R', destination: 'bench',      arcHeight: 80,  durationMs: 1100, gag: 'flip'    },
  Edit:         { glyph: '✏️', glyphChar: 'E', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  Write:        { glyph: '✏️', glyphChar: 'W', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  NotebookEdit: { glyph: '✏️', glyphChar: 'N', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  Grep:         { glyph: '🔍', glyphChar: 'G', destination: 'bench',      arcHeight: 75,  durationMs: 1100, gag: 'glow'    },
  Glob:         { glyph: '🔦', glyphChar: 'L', destination: 'floor',      arcHeight: 70,  durationMs: 1000, gag: 'fan'     },
  WebFetch:     { glyph: '🛰️', glyphChar: 'F', destination: 'sky',        arcHeight: 140, durationMs: 1800, gag: 'orbit'   },
  WebSearch:    { glyph: '🛰️', glyphChar: 'S', destination: 'sky',        arcHeight: 140, durationMs: 1800, gag: 'orbit'   },
  Task:         { glyph: '🤖', glyphChar: 'T', destination: 'dock',       arcHeight: 90,  durationMs: 1300, gag: 'boot'    },
  TodoWrite:    { glyph: '📋', glyphChar: 'O', destination: 'kanban',     arcHeight: 90,  durationMs: 1200, gag: 'tick'    },
  ExitPlanMode: { glyph: '📝', glyphChar: 'P', destination: 'whiteboard', arcHeight: 85,  durationMs: 1300, gag: 'sparkle' },
  BashOutput:   { glyph: '📜', glyphChar: '>', destination: 'conveyor',   arcHeight: 80,  durationMs: 1100, gag: 'unfurl'  },
  KillBash:     { glyph: '💥', glyphChar: 'X', destination: 'conveyor',   arcHeight: 90,  durationMs: 900,  gag: 'puff'    },
}

export const FALLBACK_RECIPE: ToolRecipe = {
  glyph: '⚙️',
  glyphChar: '📦',
  destination: 'bench',
  arcHeight: 80,
  durationMs: 1200,
  gag: 'spin',
}
