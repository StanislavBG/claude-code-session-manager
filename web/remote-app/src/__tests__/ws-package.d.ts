// Types for the `ws` npm package, which ships none (@types/ws is not a dependency here): only the slice
// the node-env browser specs use, with @types/ws 8.5 signatures. Vite's inlined copy (`WebSocket` from
// 'vite') can't stand in: its ServerOptions.server resolves to ws's own Server class, so
// `new WebSocketServer({ server: httpServer })` fails. Delete this file if @types/ws is ever added.
declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { IncomingMessage, Server as HTTPServer } from 'node:http';
  import type { Server as HTTPSServer } from 'node:https';

  /** The raw message payload received over the socket. */
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    readonly readyState: 0 | 1 | 2 | 3;
    send(data: string | ArrayBuffer | ArrayBufferView, cb?: (err?: Error) => void): void;
    terminate(): void;
    on(event: 'message', listener: (this: WebSocket, data: RawData, isBinary: boolean) => void): this;
  }

  export interface ServerOptions {
    server?: HTTPServer | HTTPSServer;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: ServerOptions, callback?: () => void);
    close(cb?: (err?: Error) => void): void;
    on(event: 'connection', cb: (this: WebSocketServer, socket: WebSocket, request: IncomingMessage) => void): this;
  }
}
