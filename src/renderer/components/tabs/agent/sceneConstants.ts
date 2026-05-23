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

// Palette — paper-warm Almanac scene. Sky is the page background (cream),
// floor and walls in slightly darker warmth so the workshop still reads as
// a "room." Bench wood keeps its terracotta-adjacent oak tones. Cards and
// stickies retuned to paper-light variants of their meaning colors.
export const PAL = {
  sky: '#f6efe1',
  floor: '#e8dcc0',
  benchTop: '#a87836',
  benchFace: '#7d5824',
  benchGrain: '#92682c',
  wallPanel: '#efe6d3',
  wallBorder: '#d9c9a8',
  whiteboardFill: '#fbf6ec',
  whiteboardBorder: '#c9b98a',
  rackBar: '#8a7a60',
  toolHook: '#5b4a36',
  stickyFill: '#fde9a3',
  stickyBorder: '#e4b85a',
  miniBotFill: '#8a7a60',
  miniBotActive: '#6f7d52',
  cardPending: '#fbf6ec',
  cardActive: '#fde6d3',
  cardDone: '#e6ecd3',
  cardBorderPending: '#d9c9a8',
  cardBorderActive: '#b85c34',
  cardBorderDone: '#6f7d52',
  steam: '#a89c80',
  inkLine: '#5b4a36',
  accentGreen: '#6f7d52',
  accentAmber: '#b85c34',
  conveyor: '#5b4a36',
} as const

// Reusable transition objects (defined once for perf)
export const SPRING_BOUNCE = { type: 'spring' as const, stiffness: 120, damping: 14 }
export const SPRING_SNAPPY = { type: 'spring' as const, stiffness: 200, damping: 20 }
export const TWEEN_FADE = { duration: 0.4, ease: 'easeOut' as const }
