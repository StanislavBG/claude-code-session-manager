export const SCENE_W = 800
export const SCENE_H = 600
export const FLOOR_Y = 305

// Scheduler dock (lower workshop strip)
export const SCHED_DOCK_Y = 484
export const SCHED_DOCK_H = 116
export const SCHED_DOCK_FLOOR_Y = 580
export const SCHED_BOT_SCALE = 0.3

// Bench
export const BENCH_L = 185
export const BENCH_R = 615
export const BENCH_FRONT_Y = 292   // front edge of top surface
export const BENCH_BACK_Y = 278    // back edge of top surface (3D)
export const BENCH_BOTTOM_Y = 355  // bottom of front face
export const BENCH_LEG_Y = 390     // foot of legs

// Robot (fixed position — no wandering in workshop mode)
export const ROBOT_CX = 400
export const ROBOT_FOOT_Y = 290
export const ROBOT_SCALE = 0.9
// Robot emits flying objects from approximately here:
export const ROBOT_EMIT_X = 400
export const ROBOT_EMIT_Y = 230

// Tool rack (above bench back)
export const RACK_Y = 262
export const RACK_L = 240
export const RACK_R = 560
export const RACK_H = 14

// Whiteboard
export const WB_X = 278
export const WB_Y = 133
export const WB_W = 244
export const WB_H = 118

// Conveyor belt (on bench top surface)
export const CONV_X = 250
export const CONV_Y = 282
export const CONV_W = 188
export const CONV_H = 8

// Kettle (right of bench surface)
export const KETTLE_X = 555
export const KETTLE_Y = 265

// Sticky notes base (left of robot on bench)
export const STICKY_X = 210
export const STICKY_Y = 270

// Subagent dock (left panel)
export const DOCK_X = 8
export const DOCK_Y = 78
export const DOCK_W = 148
export const DOCK_H = 200

// Todo board (right panel)
export const BOARD_X = 644
export const BOARD_Y = 58
export const BOARD_W = 148
export const BOARD_H = 230

// Palette
export const PAL = {
  sky: '#0b0d10',
  floor: '#1a1d23',
  benchTop: '#7a5c1e',
  benchFace: '#5c4415',
  benchGrain: '#6a5019',
  wallPanel: '#141720',
  wallBorder: '#2a2f3a',
  whiteboardFill: '#e8dfc8',
  whiteboardBorder: '#c9b98a',
  rackBar: '#374151',
  toolHook: '#9ca3af',
  stickyFill: '#fef3c7',
  stickyBorder: '#fde68a',
  miniBotFill: '#6b7280',
  miniBotActive: '#34d399',
  cardPending: '#1e293b',
  cardActive: '#1e3a5f',
  cardDone: '#142a1a',
  cardBorderPending: '#334155',
  cardBorderActive: '#3b82f6',
  cardBorderDone: '#22c55e',
  steam: '#94a3b8',
  inkLine: '#374151',
  accentGreen: '#34d399',
  accentAmber: '#fbbf24',
  conveyor: '#1f2937',
} as const

// Reusable transition objects (defined once for perf)
export const SPRING_BOUNCE = { type: 'spring' as const, stiffness: 120, damping: 14 }
export const SPRING_SNAPPY = { type: 'spring' as const, stiffness: 200, damping: 20 }
export const TWEEN_FADE = { duration: 0.4, ease: 'easeOut' as const }
