// Faithful in-memory D1 binding for Worker-compatible tests.
//
// Backed by node:sqlite (Node >= 22.5) so tests execute real SQL against a
// real SQLite engine instead of a hand-rolled mock. Implements the subset of
// the D1Database surface the Worker uses:
//   prepare(sql).bind(...args).run() | .all<T>() | .first<T>()
// plus exec() for applying migration files verbatim.
//
// Ambient type shims for the node: builtins live in node-shims.d.ts so the
// worker's tsconfig stays free of @types/node.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

// Applied in the same order wrangler applies them. Two deliberate skips:
//  - 005_flyer_softdelete.sql duplicates the ALTERs in 005_enhancements.sql
//    (it only adds a non-essential index), so both cannot apply cleanly.
//  - 009 is the DEFERRED tenant NOT NULL migration.
export const APPLIED_MIGRATIONS = [
  '001_schema.sql',
  '002_branding.sql',
  '003_rsvp.sql',
  '004_setup.sql',
  '005_enhancements.sql',
  '006_agent_photo_2.sql',
  '007_admin_audit.sql',
  '008_events_tenant_id.sql',
  '010_admin_sessions.sql',
];

interface D1Result {
  success: boolean;
  meta: Record<string, unknown>;
  results?: unknown[];
}

interface StatementRunner {
  run: () => Promise<D1Result>;
  all: <T>() => Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  first: <T>() => Promise<T | null>;
}

export class SqliteD1 {
  private db: DatabaseSync;

  constructor(seedSql = '') {
    this.db = new DatabaseSync(':memory:');
    if (seedSql) this.db.exec(seedSql);
  }

  /** Apply migrations from the repo's migrations directory. */
  applyMigrations(files: string[] = APPLIED_MIGRATIONS): void {
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      this.db.exec(sql);
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): {
    bind: (...args: unknown[]) => StatementRunner;
    run: () => Promise<D1Result>;
    all: <T>() => Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
    first: <T>() => Promise<T | null>;
  } {
    const stmt = this.db.prepare(sql);
    const makeRunner = (args: unknown[]): StatementRunner => ({
      run: async () => {
        stmt.run(...args);
        return { success: true, meta: {} };
      },
      all: async <T>() => {
        const rows = stmt.all(...args) as unknown as T[];
        return { results: rows, success: true, meta: {} };
      },
      first: async <T>() => {
        const row = stmt.get(...args) as unknown as T | undefined;
        return row ?? null;
      },
    });
    const direct = makeRunner([]);
    return {
      bind: (...args: unknown[]) => makeRunner(args),
      run: direct.run,
      all: direct.all,
      first: direct.first,
    };
  }

  /** Convenience raw queries for assertions. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null {
    const row = this.db.prepare(sql).get(...params) as unknown as T | undefined;
    return row ?? null;
  }

  /** Access to the underlying DatabaseSync (for transaction control in tests). */
  get raw(): DatabaseSync {
    return this.db;
  }
}
