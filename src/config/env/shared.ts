import { z } from 'zod';

export function envBoolean(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') return undefined;
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
      return value;
    }
    if (typeof value === 'number') return value !== 0;
    return value;
  }, z.boolean().default(defaultValue));
}

export const riskProfileSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return undefined;
    return normalized;
  }
  return value;
}, z.enum(['near_zero', 'moderate', 'high', 'extra_high']).default('extra_high'));

export const llmEndpointSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  return normalized;
}, z.enum(['chat.completions', 'messages', 'responses']).optional());

export const marketCatalogOrderSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  return normalized;
}, z.enum(['volume24hr', 'newest']).default('volume24hr'));
