import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Open a Server-Sent Events stream. Returns { send, onClose }. */
export function openSse(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  const closers = [() => clearInterval(ping)];
  req.on('close', () => closers.forEach((fn) => fn()));

  return {
    send: (data) => res.write(`data: ${JSON.stringify(data)}\n\n`),
    onClose: (fn) => closers.push(fn),
  };
}
