import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  formatConformanceReport,
  runConformance,
  type ConformanceReport,
} from "../../conformance/src/conformance.js";
import { ReferenceReceiver } from "../../receiver/reference/src/receiver.js";

const receiverToken = "blackbox-only-token";
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const receiver = new ReferenceReceiver({ token: receiverToken });
  server = receiver.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The black-box target did not expose a TCP address.");
  }
  baseUrl = "http://127.0.0.1:" + (address as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("GOPP v1 black-box conformance harness", () => {
  it("passes the Reference Receiver using only HTTP observations", async () => {
    const report: ConformanceReport = await runConformance({
      baseUrl,
      token: receiverToken,
    });
    const requiredTestIds = [
      "authentication",
      "verify",
      "channels",
      "minimal_content",
      "idempotency",
      "update",
      "draft",
      "published",
      "content_format",
      "channel",
      "tags",
      "seo",
      "media",
      "revision",
      "invalid_content",
      "request_id",
    ];

    expect(report.protocol).toBe("GOPP");
    expect(report.version).toBe("1.0");
    expect(report.result).toBe("pass");
    expect(report.summary.failed).toBe(0);
    expect(report.tests.map((test) => test.id)).toEqual(
      expect.arrayContaining(requiredTestIds),
    );
    expect(report.tests.find((test) => test.id === "transport_https")?.result).toBe(
      "skip",
    );
    expect(formatConformanceReport(report)).toContain("Result: PASS");
    expect(JSON.stringify(report)).not.toContain(receiverToken);
  });
});
