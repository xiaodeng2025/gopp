import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  GoppClient,
  GoppTransportSecurityError,
  LOCAL_TEST_TRANSPORT_SECURITY,
  LocalValidationError,
} from "../src/client.js";

const token = "transport-security-test-token";
const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server || !server.listening) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

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
    throw new Error("The local test server did not expose a TCP address.");
  }
  return {
    baseUrl: "http://127.0.0.1:" + (address as AddressInfo).port,
    server,
  };
}

function sendVerify(response: ServerResponse): void {
  const body = JSON.stringify({
    protocol: "GOPP",
    protocol_version: "1.0",
    request_id: "transport-security-verify",
    data: {
      site: { name: "Local test receiver" },
      capabilities: {
        content_formats: ["html"],
        statuses: ["draft"],
        upsert: true,
        channels: false,
        tags: false,
        seo: false,
        media: false,
        revision: false,
        extensions: [],
      },
    },
  });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(body);
}

function assertSecurityError(
  action: () => unknown,
  code: "insecure_scheme" | "blocked_target",
): void {
  try {
    action();
    throw new Error("Expected a transport security error.");
  } catch (error) {
    expect(error).toBeInstanceOf(GoppTransportSecurityError);
    expect(error).toMatchObject({ kind: "transport_security", code });
    expect(JSON.stringify(error)).not.toContain(token);
  }
}

describe("GOPP Publisher transport security", () => {
  it("requires HTTPS by default and keeps credentials out of security errors", () => {
    assertSecurityError(
      () => new GoppClient({ baseUrl: "http://example.com", token }),
      "insecure_scheme",
    );
    assertSecurityError(
      () => new GoppClient({ baseUrl: "https://user:password@example.com", token }),
      "blocked_target",
    );
  });

  it("rejects malformed and non-HTTP(S) base URLs locally", () => {
    expect(() => new GoppClient({ baseUrl: "not a URL", token })).toThrow(LocalValidationError);
    expect(() => new GoppClient({ baseUrl: "file:///tmp/receiver", token })).toThrow(LocalValidationError);
    expect(() => new GoppClient({ baseUrl: "https://-invalid.example", token })).toThrow(LocalValidationError);
  });

  it("blocks loopback, private, link-local, and IPv6 local targets without an explicit policy", () => {
    for (const baseUrl of [
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://192.168.0.1",
      "https://169.254.0.1",
      "https://[::1]",
    ]) {
      assertSecurityError(
        () => new GoppClient({ baseUrl, token }),
        "blocked_target",
      );
    }
  });

  it("permits an explicit local-only test policy", async () => {
    const target = await startServer((_request, response) => sendVerify(response));
    const client = new GoppClient({
      baseUrl: target.baseUrl,
      token,
      transportSecurity: LOCAL_TEST_TRANSPORT_SECURITY,
    });

    await expect(client.verify()).resolves.toMatchObject({ protocol: "GOPP" });
  });

  it("enforces an exact allowed-host list before sending", () => {
    assertSecurityError(
      () => new GoppClient({
        baseUrl: "https://example.com",
        token,
        transportSecurity: { allowedHosts: ["receiver.example"] },
      }),
      "blocked_target",
    );
  });

  it("does not let the legacy private-network option broaden egress", () => {
    assertSecurityError(
      () => new GoppClient({
        baseUrl: "https://127.0.0.1",
        token,
        transportSecurity: { allowPrivateNetwork: true },
      }),
      "blocked_target",
    );
  });

  it("rejects public and private HTTP even when HTTPS is relaxed for tests", () => {
    for (const baseUrl of ["http://example.com", "http://10.0.0.1"]) {
      assertSecurityError(
        () => new GoppClient({
          baseUrl,
          token,
          transportSecurity: { requireHttps: false },
        }),
        "blocked_target",
      );
    }
  });

  it("allows a public HTTPS target under the normal production policy", () => {
    expect(() => new GoppClient({ baseUrl: "https://example.com", token })).not.toThrow();
  });

  it("does not follow redirects or transfer the bearer token", async () => {
    let redirectedRequests = 0;
    let redirectedAuthorization: string | undefined;
    const destination = await startServer((request, response) => {
      redirectedRequests += 1;
      redirectedAuthorization = request.headers.authorization;
      sendVerify(response);
    });
    const source = await startServer((_request, response) => {
      response.writeHead(302, { Location: destination.baseUrl + "/captured" });
      response.end();
    });
    const client = new GoppClient({
      baseUrl: source.baseUrl,
      token,
      maxRetries: 0,
      transportSecurity: LOCAL_TEST_TRANSPORT_SECURITY,
    });

    const error = await client.verify().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoppTransportSecurityError);
    expect(error).toMatchObject({ code: "redirect_blocked" });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(redirectedRequests).toBe(0);
    expect(redirectedAuthorization).toBeUndefined();
  });
});
