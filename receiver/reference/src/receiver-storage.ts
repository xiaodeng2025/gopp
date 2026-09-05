import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface StoredResource {
  body: Record<string, unknown>;
  remote_id: string;
  revision?: number;
  created_at: string;
  updated_at: string;
}

export interface ReceiverStorage {
  count(): number;
  get(sourceId: string): StoredResource | undefined;
  create(sourceId: string, resource: StoredResource): void;
  replace(sourceId: string, resource: StoredResource): void;
  close?(): void;
}

export class MemoryReceiverStorage implements ReceiverStorage {
  private readonly resources = new Map<string, StoredResource>();

  public count(): number {
    return this.resources.size;
  }

  public get(sourceId: string): StoredResource | undefined {
    const resource = this.resources.get(sourceId);
    return resource ? cloneResource(resource) : undefined;
  }

  public create(sourceId: string, resource: StoredResource): void {
    if (this.resources.has(sourceId)) {
      throw new Error("A Receiver resource already exists for this source_id.");
    }
    this.resources.set(sourceId, cloneResource(resource));
  }

  public replace(sourceId: string, resource: StoredResource): void {
    this.resources.set(sourceId, cloneResource(resource));
  }
}

export class SqliteTestStorage implements ReceiverStorage {
  private readonly database: DatabaseSync;

  public constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gopp_test_resources (
        source_id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        remote_id TEXT NOT NULL UNIQUE
      )
    `);
  }

  public count(): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM gopp_test_resources",
    ).get() as { count: number };
    return row.count;
  }

  public get(sourceId: string): StoredResource | undefined {
    const row = this.database.prepare(`
      SELECT body_json, revision, created_at, updated_at, remote_id
      FROM gopp_test_resources
      WHERE source_id = ?
    `).get(sourceId) as StoredRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      body: JSON.parse(row.body_json) as Record<string, unknown>,
      remote_id: row.remote_id,
      ...(row.revision === null ? {} : { revision: row.revision }),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public create(sourceId: string, resource: StoredResource): void {
    this.database.prepare(`
      INSERT INTO gopp_test_resources
        (source_id, body_json, revision, created_at, updated_at, remote_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sourceId,
      JSON.stringify(resource.body),
      resource.revision ?? null,
      resource.created_at,
      resource.updated_at,
      resource.remote_id,
    );
  }

  public replace(sourceId: string, resource: StoredResource): void {
    this.database.prepare(`
      UPDATE gopp_test_resources
      SET body_json = ?, revision = ?, updated_at = ?, remote_id = ?
      WHERE source_id = ?
    `).run(
      JSON.stringify(resource.body),
      resource.revision ?? null,
      resource.updated_at,
      resource.remote_id,
      sourceId,
    );
  }

  public close(): void {
    this.database.close();
  }
}

interface StoredRow {
  body_json: string;
  revision: number | null;
  created_at: string;
  updated_at: string;
  remote_id: string;
}

export function createStoredResource(
  body: Record<string, unknown>,
  revision: number | undefined,
): StoredResource {
  const now = new Date().toISOString();
  return {
    body: cloneBody(body),
    remote_id: "ref_" + randomUUID(),
    ...(revision === undefined ? {} : { revision }),
    created_at: now,
    updated_at: now,
  };
}

export function updatedStoredResource(
  existing: StoredResource,
  body: Record<string, unknown>,
  revision: number | undefined,
): StoredResource {
  return {
    body: cloneBody(body),
    remote_id: existing.remote_id,
    ...(revision === undefined ?
      (existing.revision === undefined ? {} : { revision: existing.revision }) :
      { revision }),
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };
}

function cloneBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function cloneResource(resource: StoredResource): StoredResource {
  return {
    ...resource,
    body: cloneBody(resource.body),
  };
}
