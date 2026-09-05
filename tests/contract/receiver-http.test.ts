import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ReferenceReceiver,
  type ReferenceReceiverOptions,
} from "../../receiver/reference/src/receiver.js";
import {
  clone,
  loadExample,
  schemaFile,
  validate,
} from "./helpers.js";

const testToken = "test-only-token";
const activeServers: Server[] = [];
type TestContent = Record<string, any>;

interface HttpResult {
  status: number;
  contentType: string;
  body: unknown;
}

interface TestHarness {
  baseUrl: string;
  receiver: ReferenceReceiver;
}

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startReceiver(
  overrides: Omit<ReferenceReceiverOptions, "token"> = {},
): Promise<TestHarness> {
  const receiver = new ReferenceReceiver({
    token: testToken,
    ...overrides,
  });
  const server = receiver.createServer();
  activeServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The test server did not expose a TCP address.");
  }
  return {
    baseUrl: "http://127.0.0.1:" + (address as AddressInfo).port,
    receiver,
  };
}

async function request(
  harness: TestHarness,
  pathname: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const requestHeaders: Record<string, string> = {
    ...headers,
  };
  const init: RequestInit = {
    method,
    headers: requestHeaders,
  };
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(harness.baseUrl + pathname, init);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: parsed,
  };
}

function authHeaders(token = testToken): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
  };
}

function minimalContent(): TestContent {
  return clone(
    loadExample("valid", "content-minimal.json"),
  ) as TestContent;
}

function problemCode(result: HttpResult): string {
  return (result.body as Record<string, unknown>).code as string;
}

function problemIsValid(result: HttpResult): boolean {
  return validate(schemaFile.problemDetails, result.body);
}

function responseData(result: HttpResult): Record<string, unknown> {
  return (result.body as Record<string, unknown>).data as Record<string, unknown>;
}

async function putContent(
  harness: TestHarness,
  sourceId: string,
  body: TestContent,
): Promise<HttpResult> {
  return request(
    harness,
    "/v1/content/" + encodeURIComponent(sourceId),
    "PUT",
    body,
    authHeaders(),
  );
}

describe("GOPP v1 Reference Receiver HTTP contract", () => {
  it("verifies with a valid token without writing resources", async () => {
    const harness = await startReceiver();
    const result = await request(
      harness,
      "/v1/verify",
      "POST",
      {},
      {
        ...authHeaders(),
        "X-Request-ID": "req-http-verify",
      },
    );

    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(validate(schemaFile.verifySuccess, result.body)).toBe(true);
    expect(
      (result.body as Record<string, unknown>).request_id,
    ).toBe("req-http-verify");
    expect(harness.receiver.getResourceCount()).toBe(0);
  });

  it("rejects missing and incorrect Bearer tokens without leaking credentials", async () => {
    const harness = await startReceiver();
    for (const headers of [{}, authHeaders("wrong-token")]) {
      const result = await request(harness, "/v1/verify", "POST", {}, headers);
      expect(result.status).toBe(401);
      expect(result.contentType).toContain("application/problem+json");
      expect(problemCode(result)).toBe("authentication_failed");
      expect(problemIsValid(result)).toBe(true);
      expect(JSON.stringify(result.body)).not.toContain(testToken);
    }
  });

  it("generates a request_id when the publisher does not provide one", async () => {
    const harness = await startReceiver();
    const result = await request(
      harness,
      "/v1/verify",
      "POST",
      {},
      authHeaders(),
    );
    const requestId = (result.body as Record<string, unknown>).request_id;
    expect(typeof requestId).toBe("string");
    expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it("returns the Receiver-owned static channels", async () => {
    const harness = await startReceiver();
    const result = await request(
      harness,
      "/v1/channels",
      "GET",
      undefined,
      authHeaders(),
    );

    expect(result.status).toBe(200);
    expect(validate(schemaFile.channelsSuccess, result.body)).toBe(true);
    expect(responseData(result).channels).toEqual([
      { id: "news", name: "News" },
      { id: "guides", name: "Guides" },
      { id: "cases", name: "Cases" },
    ]);
  });

  it("keeps the channels route and returns an empty list when channels=false", async () => {
    const harness = await startReceiver({
      capabilities: { channels: false },
    });
    const result = await request(
      harness,
      "/v1/channels",
      "GET",
      undefined,
      authHeaders(),
    );

    expect(result.status).toBe(200);
    expect(validate(schemaFile.channelsSuccess, result.body)).toBe(true);
    expect(responseData(result).channels).toEqual([]);
  });

  it("implements created, unchanged, and updated with one logical resource", async () => {
    const harness = await startReceiver();
    const firstBody = minimalContent();
    const created = await putContent(harness, "service-001", firstBody);
    const unchanged = await putContent(harness, "service-001", firstBody);
    const changedBody = minimalContent();
    changedBody.title = "修改后的标题";
    const updated = await putContent(harness, "service-001", changedBody);

    expect(created.status).toBe(201);
    expect(validate(schemaFile.contentSuccess, created.body)).toBe(true);
    expect(responseData(created).result).toBe("created");
    expect(unchanged.status).toBe(200);
    expect(responseData(unchanged).result).toBe("unchanged");
    expect(updated.status).toBe(200);
    expect(responseData(updated).result).toBe("updated");
    expect(harness.receiver.getResourceCount()).toBe(1);
    expect(responseData(created).remote_id).toBe(responseData(updated).remote_id);
  });

  it("decodes source_id from the URI and persists omitted status as draft", async () => {
    const harness = await startReceiver();
    const result = await putContent(harness, "opaque source", minimalContent());
    const stored = harness.receiver.getStoredResource("opaque source");

    expect(result.status).toBe(201);
    expect(stored?.body.status).toBe("draft");
    expect(harness.receiver.getResourceCount()).toBe(1);
  });

  it("rejects an empty source_id instead of creating an ambiguous resource", async () => {
    const harness = await startReceiver();
    const result = await request(
      harness,
      "/v1/content/",
      "PUT",
      minimalContent(),
      authHeaders(),
    );

    expect(result.status).toBe(400);
    expect(problemCode(result)).toBe("invalid_request");
    expect(problemIsValid(result)).toBe(true);
    expect(harness.receiver.getResourceCount()).toBe(0);
  });

  it("accepts a full standard content body through the same Phase 1A schema", async () => {
    const harness = await startReceiver();
    const full = clone(
      loadExample("valid", "content-full.json"),
    ) as TestContent;
    full.channel = { id: "guides", name: "Guides" };
    const result = await putContent(harness, "full-content-001", full);

    expect(result.status).toBe(201);
    expect(validate(schemaFile.contentSuccess, result.body)).toBe(true);
    expect(responseData(result).result).toBe("created");
    expect(harness.receiver.getResourceCount()).toBe(1);
  });

  it("rejects malformed content with Problem Details", async () => {
    const harness = await startReceiver();
    const invalid = minimalContent();
    delete (invalid as Record<string, unknown>).title;
    const result = await putContent(harness, "invalid-001", invalid);

    expect(result.status).toBe(422);
    expect(result.contentType).toContain("application/problem+json");
    expect(problemCode(result)).toBe("invalid_content");
    expect(problemIsValid(result)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("node_modules");
    expect(JSON.stringify(result.body)).not.toContain("test-only-token");
  });

  it("rejects non-html content with unsupported_content_format", async () => {
    const harness = await startReceiver();
    const body = minimalContent();
    body.content.format = "markdown";
    const result = await putContent(harness, "format-001", body);

    expect(result.status).toBe(415);
    expect(problemCode(result)).toBe("unsupported_content_format");
    expect(problemIsValid(result)).toBe(true);
  });

  it("enforces draft-only status without silent downgrade", async () => {
    const harness = await startReceiver({
      capabilities: { statuses: ["draft"] },
    });
    const body = minimalContent();
    body.status = "published";
    const result = await putContent(harness, "draft-only-001", body);

    expect(result.status).toBe(422);
    expect(problemCode(result)).toBe("invalid_content");
    expect(problemIsValid(result)).toBe(true);
    expect(harness.receiver.getResourceCount()).toBe(0);
  });

  it("enforces tags, seo, and media capabilities when fields are sent", async () => {
    const harness = await startReceiver({
      capabilities: {
        tags: false,
        seo: false,
        media: false,
      },
    });
    for (const [field, value] of [
      ["tags", ["one"]],
      ["seo", { title: "SEO" }],
      ["media", { cover: { url: "https://example.com/cover.jpg" } }],
    ] as const) {
      const body = minimalContent();
      body[field] = value;
      const result = await putContent(harness, "cap-" + field, body);
      expect(result.status).toBe(422);
      expect(problemCode(result)).toBe("invalid_content");
      expect(problemIsValid(result)).toBe(true);
    }
  });

  it("enforces channels and current channel IDs", async () => {
    const noChannels = await startReceiver({
      capabilities: { channels: false },
    });
    const withChannel = minimalContent();
    withChannel.channel = { id: "news" };
    const disabled = await putContent(noChannels, "channel-disabled", withChannel);
    expect(disabled.status).toBe(422);
    expect(problemCode(disabled)).toBe("invalid_content");
    expect(problemIsValid(disabled)).toBe(true);

    const harness = await startReceiver();
    const unknownChannel = minimalContent();
    unknownChannel.channel = { id: "does-not-exist" };
    const missing = await putContent(harness, "channel-missing", unknownChannel);
    expect(missing.status).toBe(404);
    expect(problemCode(missing)).toBe("channel_not_found");
    expect(problemIsValid(missing)).toBe(true);
  });

  it("implements the frozen revision conflict rules", async () => {
    const harness = await startReceiver();
    const first = minimalContent();
    first.revision = 1;
    const created = await putContent(harness, "revision-001", first);

    const higher = minimalContent();
    higher.title = "Revision two";
    higher.revision = 2;
    const updated = await putContent(harness, "revision-001", higher);
    const sameRevisionSameBody = await putContent(harness, "revision-001", higher);

    const lower = minimalContent();
    lower.title = "Old revision";
    lower.revision = 1;
    const lowerResult = await putContent(harness, "revision-001", lower);

    const sameRevisionDifferentBody = minimalContent();
    sameRevisionDifferentBody.revision = 2;
    const conflict = await putContent(
      harness,
      "revision-001",
      sameRevisionDifferentBody,
    );

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(responseData(updated).result).toBe("updated");
    expect(responseData(sameRevisionSameBody).result).toBe("unchanged");
    expect(lowerResult.status).toBe(409);
    expect(problemCode(lowerResult)).toBe("resource_conflict");
    expect(conflict.status).toBe(409);
    expect(problemCode(conflict)).toBe("resource_conflict");
    expect(problemIsValid(lowerResult)).toBe(true);
    expect(problemIsValid(conflict)).toBe(true);
  });

  it("supports a revision=false Receiver without requiring revisionless publishers to change", async () => {
    const harness = await startReceiver({
      capabilities: { revision: false },
    });
    const verify = await request(
      harness,
      "/v1/verify",
      "POST",
      {},
      authHeaders(),
    );
    const capabilities = (
      (verify.body as Record<string, unknown>).data as Record<string, unknown>
    ).capabilities as Record<string, unknown>;
    expect(capabilities.revision).toBe(false);

    const body = minimalContent();
    body.revision = 1;
    const rejected = await putContent(harness, "revision-disabled", body);
    expect(rejected.status).toBe(422);
    expect(problemCode(rejected)).toBe("invalid_content");
    expect(problemIsValid(rejected)).toBe(true);
    expect(harness.receiver.getResourceCount()).toBe(0);
  });

  it("uses a documented Reference-only policy for omitted revision after a revisioned write", async () => {
    const harness = await startReceiver();
    const revisioned = minimalContent();
    revisioned.revision = 1;
    await putContent(harness, "mixed-revision-001", revisioned);

    const noRevisionSame = minimalContent();
    const unchanged = await putContent(
      harness,
      "mixed-revision-001",
      noRevisionSame,
    );
    const noRevisionChanged = minimalContent();
    noRevisionChanged.title = "Changed without revision";
    const updated = await putContent(
      harness,
      "mixed-revision-001",
      noRevisionChanged,
    );

    expect(responseData(unchanged).result).toBe("unchanged");
    expect(responseData(updated).result).toBe("updated");
    expect(harness.receiver.getStoredResource("mixed-revision-001")?.revision).toBe(1);
  });

  it("reports unsupported protocol versions separately from unknown routes", async () => {
    const harness = await startReceiver();
    const result = await request(
      harness,
      "/v2/verify",
      "POST",
      {},
      authHeaders(),
    );

    expect(result.status).toBe(400);
    expect(problemCode(result)).toBe("unsupported_protocol_version");
    expect(problemIsValid(result)).toBe(true);
  });

  it("returns problem+json for malformed JSON without stack details", async () => {
    const harness = await startReceiver();
    const response = await fetch(harness.baseUrl + "/v1/verify", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: "{",
    });
    const body = (await response.json()) as unknown;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(validate(schemaFile.problemDetails, body)).toBe(true);
    expect(serialized).not.toContain("Error:");
    expect(serialized).not.toContain("node_modules");
  });

  it("keeps concurrent identical PUTs at one logical resource", async () => {
    const harness = await startReceiver();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        putContent(harness, "concurrent-001", minimalContent()),
      ),
    );
    const resultNames = results.map(
      (result) => responseData(result).result,
    );

    expect(harness.receiver.getResourceCount()).toBe(1);
    expect(resultNames.filter((result) => result === "created")).toHaveLength(1);
    expect(resultNames.filter((result) => result === "unchanged")).toHaveLength(11);
    expect(resultNames.every((result) => result === "created" || result === "unchanged")).toBe(
      true,
    );
    expect(results.every((result) => validate(schemaFile.contentSuccess, result.body))).toBe(
      true,
    );
  });
});
