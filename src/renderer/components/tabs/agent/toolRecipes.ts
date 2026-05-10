export type GagType =
  | 'spark' | 'flip' | 'scribble' | 'glow' | 'fan' | 'orbit'
  | 'tick' | 'boot' | 'sparkle' | 'unfurl' | 'puff' | 'spin'

export type DestinationType = 'bench' | 'kanban' | 'dock' | 'whiteboard' | 'conveyor' | 'sky' | 'floor'

export interface ToolRecipe {
  glyph: string
  destination: DestinationType
  arcHeight: number    // px — peak of flight arc above midpoint
  durationMs: number   // total fly + gag time
  gag: GagType
}

export const TOOL_RECIPES: Record<string, ToolRecipe> = {
  Bash:         { glyph: '🔧', destination: 'conveyor',  arcHeight: 100, durationMs: 1200, gag: 'spark'   },
  Read:         { glyph: '📖', destination: 'bench',      arcHeight: 80,  durationMs: 1100, gag: 'flip'    },
  Edit:         { glyph: '✏️', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  Write:        { glyph: '✏️', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  NotebookEdit: { glyph: '✏️', destination: 'bench',      arcHeight: 80,  durationMs: 1000, gag: 'scribble' },
  Grep:         { glyph: '🔍', destination: 'bench',      arcHeight: 75,  durationMs: 1100, gag: 'glow'    },
  Glob:         { glyph: '🔦', destination: 'floor',      arcHeight: 70,  durationMs: 1000, gag: 'fan'     },
  WebFetch:     { glyph: '🛰️', destination: 'sky',        arcHeight: 140, durationMs: 1800, gag: 'orbit'   },
  WebSearch:    { glyph: '🛰️', destination: 'sky',        arcHeight: 140, durationMs: 1800, gag: 'orbit'   },
  Task:         { glyph: '🤖', destination: 'dock',       arcHeight: 90,  durationMs: 1300, gag: 'boot'    },
  TodoWrite:    { glyph: '📋', destination: 'kanban',     arcHeight: 90,  durationMs: 1200, gag: 'tick'    },
  ExitPlanMode: { glyph: '📝', destination: 'whiteboard', arcHeight: 85,  durationMs: 1300, gag: 'sparkle' },
  BashOutput:   { glyph: '📜', destination: 'conveyor',   arcHeight: 80,  durationMs: 1100, gag: 'unfurl'  },
  KillBash:     { glyph: '💥', destination: 'conveyor',   arcHeight: 90,  durationMs: 900,  gag: 'puff'    },
}

export const FALLBACK_RECIPE: ToolRecipe = {
  glyph: '⚙️',
  destination: 'bench',
  arcHeight: 80,
  durationMs: 1200,
  gag: 'spin',
}
