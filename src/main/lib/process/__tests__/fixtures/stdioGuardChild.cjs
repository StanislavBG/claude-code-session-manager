'use strict';

// Child for stdioGuard.test.cjs. argv: <guard|control> <stdout|stderr>
// Protocol: touch the stream (Node creates it lazily), send 'ready'; the parent
// destroys its end of the pipe and sends 'go'; write on separate ticks, then
// report { uncaught, logCalls } over IPC and exit.
const path = require('node:path');

const mode = process.argv[2];
const target = process.argv[3];
let uncaught = 0;
const logCalls = [];

process.on('uncaughtException', () => { uncaught += 1; });

const stream = target === 'stderr' ? process.stderr : process.stdout;
void stream.fd;

if (mode === 'guard') {
  const { guardStdio } = require(path.resolve(__dirname, '..', '..', 'stdioGuard.cjs'));
  guardStdio({ log: (info) => { logCalls.push(info); } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('message', async (msg) => {
  if (msg !== 'go') return;
  for (let i = 0; i < 10; i += 1) {
    if (target === 'stderr') {
      if (i % 2) console.warn(`warn ${i}`); else console.error(`error ${i}`);
    } else {
      console.log(`log ${i}`);
    }
    await sleep(5);
  }
  if (mode === 'guard') {
    let cbCalls = 0;
    stream.write('direct 1\n', () => { cbCalls += 1; });
    await sleep(5);
    stream.write('direct 2\n', 'utf8', () => { cbCalls += 1; });
    await sleep(5);
    if (cbCalls < 1) logCalls.push({ note: 'write callback not called' });
  }
  await sleep(50);
  process.send({ uncaught, logCalls }, () => process.exit(0));
});

process.send('ready');
