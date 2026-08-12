// Real in-memory R2 bucket mock with injectable failures.
//
// Unlike `{} as unknown as R2Bucket`, this implements the R2 surface the
// Worker uses (get / put / delete / list plus writeHttpMetadata) against a
// real Map, and lets tests fail specific operations or key prefixes so the
// media-ops failure/retry matrix can be exercised deterministically.

export interface MockR2Object {
  key: string;
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  size: number;
  uploaded: string;
  writeHttpMetadata?: (target: Headers) => void;
}

async function toStream(value: any): Promise<ReadableStream<Uint8Array>> {
  if (typeof value === 'string') {
    return new Blob([value]).stream();
  }
  if (value instanceof Blob) {
    return value.stream();
  }
  if (value && typeof value.stream === 'function') {
    return value.stream();
  }
  const buf = await new Response(value as BodyInit).arrayBuffer();
  return new Blob([buf]).stream();
}

export class MockR2Bucket {
  readonly store = new Map<string, MockR2Object>();
  putFailAll = false;
  putFailPrefix: string | null = null;
  getFailKeys = new Set<string>();
  deleteFailKeys = new Set<string>();
  deleteFailPrefix: string | null = null;

  async put(
    key: string,
    value: any,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<MockR2Object> {
    if (this.putFailAll || (this.putFailPrefix !== null && key.startsWith(this.putFailPrefix))) {
      // Deliberately embed the key in the error message: every log/error path
      // must still use fixed codes and never surface this.
      throw new Error(`MockR2Bucket: put failed for key ${key}`);
    }
    const stream = await toStream(value);
    const body = new Blob([await new Response(stream).arrayBuffer()]).stream();
    const obj: MockR2Object = {
      key,
      body,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      size: 0,
      uploaded: new Date().toISOString(),
    };
    const buf = await new Response(body).arrayBuffer();
    obj.size = buf.byteLength;
    obj.body = new Blob([buf]).stream();
    this.store.set(key, obj);
    return obj;
  }

  async get(key: string): Promise<MockR2Object | null> {
    if (this.getFailKeys.has(key)) {
      throw new Error(`MockR2Bucket: get failed for key ${key}`);
    }
    const o = this.store.get(key);
    if (!o) return null;
    return {
      ...o,
      writeHttpMetadata(target: Headers): void {
        writeHttpMetadata(target, o.httpMetadata);
      },
    };
  }

  async delete(key: string): Promise<void> {
    if (this.deleteFailKeys.has(key) || (this.deleteFailPrefix !== null && key.startsWith(this.deleteFailPrefix))) {
      throw new Error(`MockR2Bucket: delete failed for key ${key}`);
    }
    this.store.delete(key);
  }

  async list(opts: { prefix?: string } = {}): Promise<{ objects: MockR2Object[]; truncated: boolean; cursor?: string }> {
    const prefix = opts.prefix || '';
    const objects = [...this.store.values()].filter((o) => o.key.startsWith(prefix)).map((o) => ({ ...o }));
    return { objects, truncated: false };
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

/** writeHttpMetadata on a plain object: sets content-type when known. */
export function writeHttpMetadata(target: Headers, meta?: { contentType?: string }): void {
  if (meta?.contentType) target.set('content-type', meta.contentType);
}
