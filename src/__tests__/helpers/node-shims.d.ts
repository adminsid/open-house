// Ambient type shims for the test-only node:sqlite D1 helper.
//
// Kept in a standalone script-style .d.ts so `declare module` introduces new
// ambient modules (in a module file it would be a module augmentation and
// fail because the real @types do not exist). This keeps @types/node out of
// the worker's tsconfig, avoiding global collisions with workers-types.

declare const process: { cwd(): string };

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number };
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown | undefined;
    };
  }
}
