import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GoppClient,
  LOCAL_TEST_TRANSPORT_SECURITY,
  GoppProtocolError,
  InvalidResponseError,
  LocalValidationError,
  TransportError,
  type Capabilities,
  type ContentInput,
  type GoppProblem,
} from "../src/client.js";
import { ReferenceReceiver } from "../../../receiver/reference/src/receiver.js";

const token = "publisher-client-test-token";
const content: ContentInput = {
  title: "测试内容",
  content: {
    format: "html",
    body: "<p>正文</p>",
  },
};

const fullCapabilities: Capabilities = {
  content_formats: ["html"],
  statuses: ["draft", "published"],
  upsert: true,
  channels: true,
  tags: true,
  seo: true,
  media: true,
  revision: true,
  extensions: [],
};

const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) {
      continue;
    }
    if (!server.listening) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function verifyResponse(
  capabilities: Capabilities = fullCapabilities,
): Record<string, unknown> {
  return {
    protocol: "GOPP",
    protocol_version: "1.0",
    request_id: "stub-verify-request",
    data: {
      site: {
        name: "Stub Receiver",
        url: "http://127.0.0.1",
      },
      capabilities,
    },
  };
}

function contentResponse(
  result: "created" | "updated" | "unchanged" = "created",
  warnings?: unknown[],
): Record<string, unknown> {
  return {
    protocol: "GOPP",
    protocol_version: "1.0",
    request_id: "stub-content-request",
    data: {
      result,
      ...(warnings ? { warnings } : {}),
    },
  };
}

function problemResponse(
  status: number,
  code: GoppProblem["code"] = "invalid_request",
  retryable = false,
  detail = "The request is invalid.",
): GoppProblem {
  return {
    type: "https://gopp.example/problems/" + code,
    title: "GOPP problem",
    status,
    code,
    request_id: "stub-problem-request",
    retryable,
    detail,
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": contentType + "; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  openServers.push(server);
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
    server,
  };
}

async function startReference(
  receiverOptions: ConstructorParameters<typeof ReferenceReceiver>[0] = {
    token,
  },
): Promise<{ baseUrl: string; receiver: ReferenceReceiver }> {
  const receiver = new ReferenceReceiver(receiverOptions);
  const server = receiver.createServer();
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The Reference Receiver did not expose a TCP address.");
  }
  return {
    baseUrl: "http://127.0.0.1:" + (address as AddressInfo).port,
    receiver,
  };
}

function client(baseUrl: string, options: Partial<ConstructorParameters<typeof GoppClient>[0]> = {}): GoppClient {
  return new GoppClient({
    baseUrl,
    token,
    transportSecurity: LOCAL_TEST_TRANSPORT_SECURITY,
    ...options,
  });
}

describe("GOPP v1 Publisher Client", () => {
  it("verifies a Reference Receiver and exposes capabilities", async () => {
    const target = await startReference();
    const result = await client(target.baseUrl).verify({
      requestId: "client-verify-request",
    });

    expect(result.protocol).toBe("GOPP");
    expect(result.protocol_version).toBe("1.0");
    expect(result.request_id).toBe("client-verify-request");
    expect(result.capabilities.content_formats).toEqual(["html"]);
    expect(result.capabilities.statuses).toEqual(["draft", "published"]);
  });

  it("caches verify and supports an explicit force refresh", async () => {
    let verifyRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        verifyRequests += 1;
        sendJson(response, 200, verifyResponse());
        return;
      }
      sendJson(response, 404, problemResponse(404), "application/problem+json");
    });
    const publisher = client(target.baseUrl);

    await publisher.verify();
    await publisher.verify();
    await publisher.verify({ force: true });

    expect(verifyRequests).toBe(2);
  });

  it("parses authentication_failed as a protocol error without exposing the token", async () => {
    const target = await startReference();
    const error = await client(target.baseUrl, { token: "wrong-token", maxRetries: 0 })
      .verify()
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GoppProtocolError);
    expect(error).toMatchObject({
      kind: "protocol",
      status: 401,
      code: "authentication_failed",
    });
    expect(JSON.stringify(error)).not.toContain("wrong-token");
  });

  it("gets channels when the Receiver declares channel support", async () => {
    const target = await startReference();
    const channels = await client(target.baseUrl).getChannels();

    expect(channels.map((channel) => channel.id)).toEqual([
      "news",
      "guides",
      "cases",
    ]);
  });

  it("skips the channels request and returns an empty list when channels=false", async () => {
    let channelRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse({
          ...fullCapabilities,
          channels: false,
        }));
        return;
      }
      if (request.url === "/v1/channels") {
        channelRequests += 1;
        sendJson(response, 200, {
          ...verifyResponse(),
          data: { channels: [] },
        });
        return;
      }
      sendJson(response, 404, problemResponse(404), "application/problem+json");
    });

    expect(await client(target.baseUrl).getChannels()).toEqual([]);
    expect(channelRequests).toBe(0);
  });

  it("returns created, unchanged, and updated for repeated content writes", async () => {
    const target = await startReference();
    const publisher = client(target.baseUrl);

    await expect(publisher.putContent("service-001", content)).resolves.toMatchObject({
      result: "created",
    });
    await expect(publisher.putContent("service-001", content)).resolves.toMatchObject({
      result: "unchanged",
    });
    await expect(
      publisher.putContent("service-001", {
        ...content,
        content: { format: "html", body: "<p>更新后的正文</p>" },
      }),
    ).resolves.toMatchObject({ result: "updated" });
  });

  it("uses the draft default and supports published when advertised", async () => {
    const target = await startReference();
    const publisher = client(target.baseUrl);

    await expect(publisher.putContent("draft-001", content)).resolves.toMatchObject({
      result: "created",
    });
    expect(target.receiver.getStoredResource("draft-001")?.body.status).toBe("draft");
    await expect(
      publisher.putContent("published-001", {
        ...content,
        status: "published",
      }),
    ).resolves.toMatchObject({ result: "created" });
  });

  it("encodes a valid source_id and joins a Receiver base path", async () => {
    let receivedPath = "";
    const target = await startServer((request, response) => {
      receivedPath = request.url ?? "";
      if (request.method === "POST" && request.url === "/receiver/v1/verify") {
        sendJson(response, 200, verifyResponse());
        return;
      }
      if (
        request.method === "PUT" &&
        request.url === "/receiver/v1/content/article-001"
      ) {
        sendJson(response, 201, contentResponse());
        return;
      }
      sendJson(response, 404, problemResponse(404), "application/problem+json");
    });

    await client(target.baseUrl + "/receiver/").putContent(
      "article-001",
      content,
    );
    expect(receivedPath).toBe(
      "/receiver/v1/content/article-001",
    );
  });

  it("parses optional warnings from a content response", async () => {
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse());
        return;
      }
      sendJson(
        response,
        201,
        contentResponse("created", [
          {
            code: "media_fetch_failed",
            field: "media.cover.url",
            message: "The optional cover image was not fetched.",
          },
        ]),
      );
    });

    await expect(client(target.baseUrl).putContent("warning-001", content)).resolves.toMatchObject({
      result: "created",
      warnings: [
        {
          code: "media_fetch_failed",
          field: "media.cover.url",
        },
      ],
    });
  });

  it.each([
    ["published", { ...content, status: "published" }],
    ["channel", { ...content, channel: { id: "news" } }],
    ["tags", { ...content, tags: ["tag"] }],
    ["seo", { ...content, seo: { title: "SEO" } }],
    ["media", { ...content, media: { images: [{ url: "https://example.com/a.jpg" }] } }],
    ["revision", { ...content, revision: 1 }],
  ])("rejects %s locally when its capability is unavailable", async (field, body) => {
    let contentRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse({
          ...fullCapabilities,
          statuses: ["draft"],
          channels: field !== "channel",
          tags: field !== "tags",
          seo: field !== "seo",
          media: field !== "media",
          revision: field !== "revision",
        }));
        return;
      }
      if (request.url?.startsWith("/v1/content/")) {
        contentRequests += 1;
      }
      sendJson(response, 500, problemResponse(500), "application/problem+json");
    });

    const error = await client(target.baseUrl).putContent(
      "capability-" + field,
      body as ContentInput,
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LocalValidationError);
    expect(error).toMatchObject({ kind: "local_validation" });
    expect(contentRequests).toBe(0);
  });

  it("rejects an unsupported content format before HTTP", async () => {
    let requests = 0;
    const target = await startServer((_request, response) => {
      requests += 1;
      sendJson(response, 500, problemResponse(500), "application/problem+json");
    });

    const invalidContent = {
      title: "不支持的格式",
      content: { format: "markdown", body: "# 正文" },
    } as unknown as ContentInput;
    const error = await client(target.baseUrl).putContent(
      "format-unsupported",
      invalidContent,
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LocalValidationError);
    expect(error).toMatchObject({ kind: "local_validation", code: "invalid_content" });
    expect(requests).toBe(0);
  });

  it("parses a valid Problem Details response", async () => {
    const target = await startServer((_request, response) => {
      sendJson(
        response,
        409,
        problemResponse(409, "resource_conflict", false, "The resource conflicts."),
        "application/problem+json",
      );
    });

    const error = await client(target.baseUrl, { maxRetries: 0 }).verify()
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoppProtocolError);
    expect(error).toMatchObject({
      status: 409,
      code: "resource_conflict",
      detail: "The resource conflicts.",
    });
  });

  it("rejects malformed success, malformed Problem Details, and non-JSON responses", async () => {
    const cases: Array<{
      body: string;
      contentType: string;
      status: number;
    }> = [
      {
        body: JSON.stringify({ protocol: "GOPP" }),
        contentType: "application/json",
        status: 200,
      },
      {
        body: JSON.stringify({}),
        contentType: "application/problem+json",
        status: 400,
      },
      {
        body: "not-json",
        contentType: "text/plain",
        status: 200,
      },
    ];

    for (const testCase of cases) {
      const target = await startServer((_request, response) => {
        response.writeHead(testCase.status, {
          "Content-Type": testCase.contentType,
        });
        response.end(testCase.body);
      });
      const error = await client(target.baseUrl, { maxRetries: 0 }).verify()
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(InvalidResponseError);
      expect(error).toMatchObject({ kind: "invalid_response" });
      await closeTrackedServers();
    }
  });

  it("reports timeout as a transport error", async () => {
    const target = await startServer((_request, response) => {
      setTimeout(() => response.end("{}"), 100);
    });

    const error = await client(target.baseUrl, {
      timeoutMs: 20,
      maxRetries: 0,
    }).verify().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "transport" });
    expect((error as Error).message).toContain("timed out");
  });

  it("reports connection failure as a transport error", async () => {
    const target = await startServer((_request, response) => {
      response.end("{}");
    });
    const address = target.server.address();
    if (!address || typeof address === "string") {
      throw new Error("The test server did not expose a port.");
    }
    await closeTrackedServers();

    const error = await client(
      "http://127.0.0.1:" + (address as AddressInfo).port,
      { maxRetries: 0 },
    ).verify().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "transport" });
  });

  it("retries a 503 response and then returns success", async () => {
    let putRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse());
        return;
      }
      if (request.url === "/v1/content/retry-503") {
        putRequests += 1;
        if (putRequests === 1) {
          response.setHeader("Retry-After", "0");
          sendJson(
            response,
            503,
            problemResponse(503, "internal_error", true),
            "application/problem+json",
          );
          return;
        }
        sendJson(response, 201, contentResponse());
        return;
      }
      sendJson(response, 404, problemResponse(404), "application/problem+json");
    });

    await expect(client(target.baseUrl).putContent("retry-503", content)).resolves.toMatchObject({
      result: "created",
    });
    expect(putRequests).toBe(2);
  });

  it("retries a valid retryable Problem Details response", async () => {
    let putRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse());
        return;
      }
      putRequests += 1;
      if (putRequests === 1) {
        response.setHeader("Retry-After", "0");
        sendJson(
          response,
          409,
          problemResponse(409, "resource_conflict", true),
          "application/problem+json",
        );
        return;
      }
      sendJson(response, 200, contentResponse("unchanged"));
    });

    await expect(client(target.baseUrl).putContent("retry-problem", content)).resolves.toMatchObject({
      result: "unchanged",
    });
    expect(putRequests).toBe(2);
  });

  it("retries a lost PUT response and accepts unchanged", async () => {
    let putRequests = 0;
    const target = await startServer((request, response) => {
      if (request.url === "/v1/verify") {
        sendJson(response, 200, verifyResponse());
        return;
      }
      putRequests += 1;
      request.resume();
      request.once("end", () => {
        if (putRequests === 1) {
          request.socket.destroy();
          return;
        }
        sendJson(response, 200, contentResponse("unchanged"));
      });
    });

    await expect(client(target.baseUrl, { maxRetries: 1 }).putContent(
      "lost-response",
      content,
    )).resolves.toMatchObject({ result: "unchanged" });
    expect(putRequests).toBe(2);
  });
});

async function closeTrackedServers(): Promise<void> {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server || !server.listening) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
