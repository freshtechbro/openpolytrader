import { existsSync, renameSync } from 'node:fs';

const SQLITE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;
const CORRUPT_ERROR_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'UNKNOWN_SQLITE_ERROR_779']);
const CORRUPT_CODE_FRAGMENTS = ['CORRUPT', 'NOTADB'] as const;
const CORRUPT_MESSAGE_FRAGMENTS = [
  'database disk image is malformed',
  'file is not a database',
  'database is corrupt'
] as const;

function isSqliteErrorRecord(error: unknown): error is { code?: unknown; message?: unknown } {
  return typeof error === 'object' && error !== null;
}

export function isReadonlyDatabaseMovedError(error: unknown): boolean {
  if (!isSqliteErrorRecord(error)) return false;
  return error.code === 'SQLITE_READONLY_DBMOVED';
}

export function isCorruptDatabaseError(error: unknown): boolean {
  if (!isSqliteErrorRecord(error)) return false;

  const code = String(error.code ?? '').toUpperCase();
  if (CORRUPT_ERROR_CODES.has(code)) return true;
  if (CORRUPT_CODE_FRAGMENTS.some((fragment) => code.includes(fragment))) return true;

  const message = String(error.message ?? '').toLowerCase();
  return CORRUPT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

export function rotateSqliteFiles(sourceBase: string, backupBase: string): void {
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    const sourcePath = `${sourceBase}${suffix}`;
    if (!existsSync(sourcePath)) continue;
    renameSync(sourcePath, `${backupBase}${suffix}`);
  }
}
