import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isCorruptDatabaseError,
  isReadonlyDatabaseMovedError,
  rotateSqliteFiles
} from '../../src/core/EventStoreRecovery.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('EventStoreRecovery', () => {
  it('classifies readonly-moved and corrupt sqlite errors', () => {
    expect(isReadonlyDatabaseMovedError({ code: 'SQLITE_READONLY_DBMOVED' })).toBe(true);
    expect(isReadonlyDatabaseMovedError({ code: 'SQLITE_CORRUPT' })).toBe(false);

    expect(isCorruptDatabaseError({ code: 'SQLITE_CORRUPT' })).toBe(true);
    expect(isCorruptDatabaseError({ code: 'unknown_sqlite_error_779' })).toBe(true);
    expect(isCorruptDatabaseError({ code: 'E_SQLITE_NOTADB_WRAPPED' })).toBe(true);
    expect(isCorruptDatabaseError({ message: 'database disk image is malformed' })).toBe(true);
    expect(isCorruptDatabaseError({ message: 'all good' })).toBe(false);
    expect(isCorruptDatabaseError(null)).toBe(false);
  });

  it('rotates sqlite files that exist and skips missing companion files', () => {
    const dir = createTempDir('event-store-recovery-');
    const sourceBase = join(dir, 'events.db');
    const backupBase = join(dir, 'events.db.corrupt-backup');

    writeFileSync(sourceBase, 'main-db');
    writeFileSync(`${sourceBase}-wal`, 'wal-db');

    rotateSqliteFiles(sourceBase, backupBase);

    expect(existsSync(sourceBase)).toBe(false);
    expect(existsSync(`${sourceBase}-wal`)).toBe(false);
    expect(existsSync(`${sourceBase}-shm`)).toBe(false);
    expect(readFileSync(backupBase, 'utf8')).toBe('main-db');
    expect(readFileSync(`${backupBase}-wal`, 'utf8')).toBe('wal-db');
    expect(existsSync(`${backupBase}-shm`)).toBe(false);
  });
});
