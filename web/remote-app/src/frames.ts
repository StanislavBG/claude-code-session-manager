// Frame chunking + send pacing for messages larger than the relay's 256 KB frame cap.
// chunkFrames is a byte-for-byte port of src/main/lib/feedback-remote/remoteIpcDispatch.cjs
// chunkFrames (the desktop's joinFrames reassembles its output); SendBudget mirrors the
// bilko.run relay's per-browser leaky bucket, which silently drops frames once it is full.

/** Max JSON-escaped bytes of one frame's `data` slice — same as the desktop's DEFAULT_FRAME_BYTES. */
export const FRAME_DATA_BYTES = 180000;

export interface Frame {
  seq: number;
  total: number;
  data: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serialize(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** UTF-8 byte length of JSON.stringify(value) (undefined serializes as null). */
export function serializedBytes(value: unknown): number {
  return encoder.encode(serialize(value)).length;
}

/** Cost of one UTF-8 byte once the slice is re-stringified as a JSON string. */
function escapeCost(b: number): number {
  if (b === 0x22 || b === 0x5c) return 2;
  if (b < 0x20) return b === 0x0a || b === 0x0d || b === 0x09 || b === 0x08 || b === 0x0c ? 2 : 6;
  return 1;
}

/**
 * Serialize once and split into ordered frames whose JSON-escaped `data` stays under maxBytes.
 * Slices never cut a UTF-8 sequence; empty input yields a single empty slice.
 */
export function chunkFrames(value: unknown, maxBytes: number = FRAME_DATA_BYTES): Frame[] {
  const buf = encoder.encode(serialize(value));
  const limit = Math.max(12, maxBytes - 1);
  const slices: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = start;
    let cost = 0;
    while (end < buf.length) {
      const c = escapeCost(buf[end]);
      if (cost + c > limit) break;
      cost += c;
      end++;
    }
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) end--;
    }
    slices.push(decoder.decode(buf.subarray(start, end)));
    start = end;
  }
  if (slices.length === 0) slices.push('');
  const total = slices.length;
  return slices.map((data, seq) => ({ seq, total, data }));
}

export interface SendBudgetOptions {
  /** Sends allowed back-to-back before pacing kicks in (below the relay's 60 for headroom). */
  capacity?: number;
  /** Milliseconds for one used token to drain. */
  refillMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Leaky bucket matching the relay: tokens = max(0, tokens - elapsed / refillMs); a send adds one.
 * take() waits only when the bucket is full; concurrent take() calls are served in order.
 */
export class SendBudget {
  private readonly capacity: number;
  private readonly refillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens = 0;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor({ capacity = 50, refillMs = 1000, now = Date.now, sleep = defaultSleep }: SendBudgetOptions = {}) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.now = now;
    this.sleep = sleep;
    this.last = now();
  }

  private drain(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.max(0, this.tokens - elapsed / this.refillMs);
  }

  /** Record a send that already happened (no waiting). */
  note(): void {
    this.drain();
    this.tokens += 1;
  }

  /** Resolve once a send fits in the bucket, then record it. */
  take(): Promise<void> {
    const run = this.queue.then(async () => {
      this.drain();
      while (this.tokens > this.capacity - 1) {
        await this.sleep(Math.ceil((this.tokens - (this.capacity - 1)) * this.refillMs));
        this.drain();
      }
      this.tokens += 1;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
