import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { queryFlag } from '../security/Auth.js';
import type { MetricEvent } from '../telemetry/metrics.js';
import type { EventStreamRouteContext } from './serverRouteContext.js';
import { opsAuthPolicyOptions } from './serverSession.js';

export function registerEventStreamRoute(app: FastifyInstance, context: EventStreamRouteContext): void {
  app.get('/stream', opsAuthPolicyOptions('stream'), handleEventStream.bind(null, context));
}

function handleEventStream(
  context: EventStreamRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
) {
  setStreamHeaders(reply.raw, request.headers.origin);
  reply.raw.flushHeaders?.();

  const maxPings = context.queryPositiveInt(request, 'maxPings');
  writeMetricEvent(reply.raw, {
    type: 'info',
    timestamp: Date.now(),
    data: { message: 'stream_connected' }
  });

  if (queryFlag(request, 'once')) {
    reply.raw.end();
    return;
  }

  const handler = (event: MetricEvent) => writeMetricEvent(reply.raw, event, toSseEventName(event));
  context.metrics.on('event', handler);

  let closed = false;
  let pingCount = 0;
  const heartbeat = setInterval(() => {
    writeStreamPing(reply.raw);
    pingCount += 1;
    if (maxPings !== null && pingCount >= maxPings) {
      cleanup();
      reply.raw.end();
    }
  }, context.streamHeartbeatMs);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    context.metrics.off('event', handler);
  };

  reply.raw.on('close', cleanup);
  reply.raw.on('finish', cleanup);
}

function setStreamHeaders(
  rawReply: { setHeader: (name: string, value: string) => void; statusCode: number },
  origin: string | string[] | undefined
): void {
  if (typeof origin === 'string') {
    rawReply.setHeader('Access-Control-Allow-Origin', origin);
    rawReply.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    rawReply.setHeader('Access-Control-Allow-Origin', '*');
  }
  rawReply.setHeader('Vary', 'Origin');
  rawReply.statusCode = 200;
  rawReply.setHeader('Content-Type', 'text/event-stream');
  rawReply.setHeader('Cache-Control', 'no-cache');
  rawReply.setHeader('Connection', 'keep-alive');
}

function writeMetricEvent(
  rawReply: { write: (chunk: string) => void },
  event: MetricEvent,
  name: string = event.type
): void {
  rawReply.write(`event: ${name}\n`);
  rawReply.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeStreamPing(rawReply: { write: (chunk: string) => void }): void {
  rawReply.write(': ping\n\n');
  rawReply.write('event: stream_ping\n');
  rawReply.write(
    `data: ${JSON.stringify({
      type: 'stream_ping',
      timestamp: Date.now(),
      data: { message: 'stream_ping' }
    })}\n\n`
  );
}

function toSseEventName(event: MetricEvent): string {
  return event.type === 'error' ? 'metric_error' : event.type;
}
