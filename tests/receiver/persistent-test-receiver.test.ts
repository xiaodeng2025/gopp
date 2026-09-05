import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ReferenceReceiver } from "../../receiver/reference/src/receiver.js";
import { SqliteTestStorage } from "../../receiver/reference/src/receiver-storage.js";
import { runConformance } from "../../conformance/src/conformance.js";

const token = "persistent-test-receiver-token";
const activeServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gopp-test-receiver-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "receiver.sqlite");
}

async function start(storage: SqliteTestStorage): Promise<string> {
  const receiver = new ReferenceReceiver({ token, storage });
  const server = receiver.createServer();
  activeServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The persistent test server did not expose a TCP address.");
  }
  return "http://127.0.0.1:" + (address as AddressInfo).port;
}

function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Persistent receiver test article",
    content: { format: "html", body: "<p>Safe test body</p>" },
    status: "published",
    ...overrides,
  };
}

async function put(
  baseUrl: string,
  sourceId: string,
  body: Record<string, unknown>,
  suppliedToken = token,
): Promise<Response> {
  return await fetch(baseUrl + "/v1/content/" + encodeURIComponent(sourceId), {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + suppliedToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function result(response: Response): Promise<string> {
  return ((await response.json()) as { data: { result: string } }).data.result;
}

describe("GOPP persistent test receiver", () => {
  it("persists created, unchanged, and updated results with a unique source_id", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      expect(await result(await put(baseUrl, "persistent-1", content()))).toBe("created");
      expect(await result(await put(baseUrl, "persistent-1", content()))).toBe("unchanged");
      expect(await result(await put(baseUrl, "persistent-1", content({ title: "Updated title" })))).toBe("updated");
      expect(storage.count()).toBe(1);
      expect(() => storage.create("persistent-1", {
        body: content(), remote_id: "another-remote-id", created_at: "now", updated_at: "now",
      })).toThrow();
    } finally {
      storage.close();
    }
  });

  it("returns unchanged after a Receiver instance is recreated", async () => {
    const filename = databasePath();
    const firstStorage = new SqliteTestStorage(filename);
    const firstBaseUrl = await start(firstStorage);
    expect(await result(await put(firstBaseUrl, "restart-1", content()))).toBe("created");
    firstStorage.close();
    const secondStorage = new SqliteTestStorage(filename);
    try {
      const secondBaseUrl = await start(secondStorage);
      expect(await result(await put(secondBaseUrl, "restart-1", content()))).toBe("unchanged");
    } finally {
      secondStorage.close();
    }
  });

  it("preserves revision conflict rules across Receiver instances", async () => {
    const filename = databasePath();
    const firstStorage = new SqliteTestStorage(filename);
    const firstBaseUrl = await start(firstStorage);
    expect(await result(await put(firstBaseUrl, "revision-1", content({ revision: 3 })))).toBe("created");
    firstStorage.close();
    const secondStorage = new SqliteTestStorage(filename);
    try {
      const secondBaseUrl = await start(secondStorage);
      const conflict = await put(secondBaseUrl, "revision-1", content({ title: "Changed", revision: 3 }));
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as { code: string }).code).toBe("resource_conflict");
    } finally {
      secondStorage.close();
    }
  });

  it("renders a published test article from persistent storage", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      await put(baseUrl, "visible-1", content({
        summary: "A summary",
        author: { name: "Test author" },
      }));
      const page = await fetch(baseUrl + "/test/articles/visible-1");
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Persistent receiver test article");
      expect(html).toContain("Safe test body");
      expect(html).toContain("A summary");
      expect(html).toContain("Test author");
      expect(html).not.toContain("DRAFT —");
    } finally {
      storage.close();
    }
  });

  it("labels draft content as test-only while still making it visible", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      await put(baseUrl, "draft-1", content({ status: "draft" }));
      const html = await (await fetch(baseUrl + "/test/articles/draft-1")).text();
      expect(html).toContain("DRAFT — visible only through this test helper route.");
    } finally {
      storage.close();
    }
  });

  it("does not render unsafe HTML or javascript URLs in the test page", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      await put(baseUrl, "xss-1", content({
        content: {
          format: "html",
          body: "<script>alert('x')</script><img src=x onerror=alert(1)><p>Safe</p><a href=\"javascript:alert(1)\">Bad link</a>",
        },
      }));
      const html = await (await fetch(baseUrl + "/test/articles/xss-1")).text();
      expect(html).toContain("<p>Safe</p>");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("javascript:");
    } finally {
      storage.close();
    }
  });

  it("returns an unauthenticated health check without exposing the token", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      const health = await fetch(baseUrl + "/healthz");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      const rejected = await put(baseUrl, "auth-1", content(), "wrong-token");
      const body = await rejected.text();
      expect(rejected.status).toBe(401);
      expect(body).not.toContain(token);
      expect(body).not.toContain("wrong-token");
    } finally {
      storage.close();
    }
  });

  it("passes the existing black-box Conformance Harness with SQLite storage", async () => {
    const storage = new SqliteTestStorage(databasePath());
    try {
      const baseUrl = await start(storage);
      const report = await runConformance({ baseUrl, token });
      expect(report.result).toBe("pass");
      expect(report.summary.failed).toBe(0);
    } finally {
      storage.close();
    }
  });
});
