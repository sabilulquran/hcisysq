// ADR-0002 port for object storage, first used by TRAIN-001 R4 (online-module videos).
// Callers know only object keys ("training/videos/<id>/<uuid>.mp4"); where the bytes live is the
// adapter's business. One adapter is active per environment, chosen by configuration at startup.
// Spec: docs/domain/training-online-modules.md M-06.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StoredObject {
  byteSize: number;
  sha256: string;
}

/** Inclusive byte range, as in HTTP `Range: bytes=start-end`. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectStorage {
  /** Streams `body` into `key`; refuses (and stores nothing) past `maxBytes`. Replaces an existing object. */
  put(key: string, body: Readable, options: { maxBytes: number }): Promise<StoredObject>;
  /** Size of the object, or null when it does not exist. */
  stat(key: string): Promise<{ byteSize: number } | null>;
  /** The whole object or one inclusive byte range of it. */
  read(key: string, range?: ByteRange): Promise<Readable>;
  /** Removes the object; removing a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Object exceeds ${maxBytes} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

const KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

/** Keys are lowercase path segments; never absolute, never `..`, never a host path. */
export function assertObjectKey(key: string) {
  if (!KEY.test(key) || key.length > 300 || key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid object key");
  }
}

function limiter(maxBytes: number) {
  let seen = 0;
  const hash = createHash("sha256");
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) return done(new ObjectTooLargeError(maxBytes));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { transform, result: (): StoredObject => ({ byteSize: seen, sha256: hash.digest("hex") }) };
}

/** Files under one root directory. The root comes from configuration (TRAINING_MEDIA_DIR). */
export class LocalFileObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string) {
    assertObjectKey(key);
    const path = resolve(this.root, ...key.split("/"));
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid object key");
    return path;
  }

  async put(key: string, body: Readable, options: { maxBytes: number }) {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.partial`;
    const limit = limiter(options.maxBytes);
    try {
      await pipeline(body, limit.transform, createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, path);
      return limit.result();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async stat(key: string) {
    try {
      const info = await stat(this.pathOf(key));
      return info.isFile() ? { byteSize: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async read(key: string, range?: ByteRange) {
    const path = this.pathOf(key);
    if (!(await this.stat(key))) throw new ObjectNotFoundError();
    return createReadStream(path, range ? { start: range.start, end: range.end } : {});
  }

  async delete(key: string) {
    await rm(this.pathOf(key), { force: true });
  }
}

/** In-memory fake for tests (ADR-0002: domain tests use fakes; contract tests cover both). */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable, options: { maxBytes: number }) {
    assertObjectKey(key);
    const limit = limiter(options.maxBytes);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(body, limit.transform, sink);
    this.objects.set(key, Buffer.concat(chunks));
    return limit.result();
  }

  async stat(key: string) {
    assertObjectKey(key);
    const object = this.objects.get(key);
    return object ? { byteSize: object.length } : null;
  }

  async read(key: string, range?: ByteRange) {
    assertObjectKey(key);
    const object = this.objects.get(key);
    if (!object) throw new ObjectNotFoundError();
    return Readable.from([range ? object.subarray(range.start, range.end + 1) : object]);
  }

  async delete(key: string) {
    assertObjectKey(key);
    this.objects.delete(key);
  }
}

/** Reads a whole (small) range into memory; used to inspect a video's MP4 boxes. */
export async function readRange(storage: ObjectStorage, key: string, range: ByteRange): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.read(key, range)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
