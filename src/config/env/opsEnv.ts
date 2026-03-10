import { z } from 'zod';

import { envBoolean } from './shared.js';

export const opsEnvShape = {
  OPS_API_ENABLED: envBoolean(true),
  OPS_API_HOST: z.string().default('0.0.0.0'),
  OPS_API_TOKEN: z.string().optional(),
  OPS_DEV_SESSION_PREFILL_ENABLED: envBoolean(false),
  OPS_ALERT_WEBHOOK_URL: z.string().optional(),
  OPS_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  OPS_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPS_STREAM_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  OPS_INCIDENTS_LIMIT: z.coerce.number().int().positive().default(100),
  OPS_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(0).default(300000),
  OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS: z.coerce.number().int().min(0).default(0),
  OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE: z.coerce.number().min(0).default(0.000001),
  OPS_BOOK_REFRESH_INTERVAL_MS: z.coerce.number().int().min(0).default(5000),
  OPS_BOOK_REFRESH_STALE_MS: z.coerce.number().int().min(0).default(10000),
  OPS_BOOK_STALE_QUARANTINE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  OPS_BOOK_STALE_QUARANTINE_WINDOW_MS: z.coerce.number().int().min(1000).default(300000),
  OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS: z.coerce.number().int().min(0).default(0),
  METRICS_MAX_EVENTS: z.coerce.number().int().positive().default(1000),
  INCIDENTS_MAX_EVENTS: z.coerce.number().int().positive().default(1000)
};
