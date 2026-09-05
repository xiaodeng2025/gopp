import { describe, expect, it } from "vitest";
import {
  clone,
  loadExample,
  protocolDocumentation,
  schemaFile,
  validate,
} from "./helpers.js";

type ContentBody = {
  [key: string]: unknown;
  content?: {
    [key: string]: unknown;
  };
  status?: string;
  revision?: number;
  source_id?: string;
  media?: {
    cover?: {
      [key: string]: unknown;
    };
  };
  channel?: {
    [key: string]: unknown;
  };
};

describe("GOPP v1 frozen semantics", () => {
  it("keeps source_id in the URI contract and out of the body", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;
    const full = loadExample("valid", "content-full.json") as ContentBody;
    expect(Object.keys(minimal).sort()).toEqual(["content", "title"]);
    expect("source_id" in minimal).toBe(false);
    expect("source_id" in full).toBe(false);

    const withSourceId = clone(minimal);
    withSourceId.source_id = "opaque-content-001";
    expect(validate(schemaFile.contentRequestBody, withSourceId)).toBe(false);
  });

  it("requires only the three frozen content fields", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;
    expect(Object.keys(minimal)).toHaveLength(2);
    expect(Object.keys(minimal.content ?? {}).sort()).toEqual(["body", "format"]);
    expect(validate(schemaFile.contentRequestBody, minimal)).toBe(true);
  });

  it("accepts omitted status with the frozen draft default and rejects non-v1 formats", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;
    expect(minimal.status).toBeUndefined();
    expect(protocolDocumentation).toContain("status 省略时默认为 draft");

    const markdown = clone(minimal);
    markdown.content = {
      ...(markdown.content ?? {}),
      format: "markdown",
    };
    expect(validate(schemaFile.contentRequestBody, markdown)).toBe(false);
  });

  it("keeps revision optional and non-negative", () => {
    const minimal = loadExample("valid", "content-minimal.json");
    expect(validate(schemaFile.contentRequestBody, minimal)).toBe(true);

    const negativeRevision = clone(minimal) as ContentBody;
    negativeRevision.revision = -1;
    expect(validate(schemaFile.contentRequestBody, negativeRevision)).toBe(false);
  });

  it("requires absolute media URLs and string channel IDs", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;

    const relativeMedia = clone(minimal);
    relativeMedia.media = { cover: { url: "/cover.jpg" } };
    expect(validate(schemaFile.contentRequestBody, relativeMedia)).toBe(false);

    const numericChannel = clone(minimal);
    numericChannel.channel = { id: 123 };
    expect(validate(schemaFile.contentRequestBody, numericChannel)).toBe(false);
  });

  it("accepts additive members only at open evolution points", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;
    const request = { ...minimal, future_hint: true };
    expect(validate(schemaFile.contentRequestBody, request)).toBe(true);

    const response = loadExample("valid", "content-created.json") as Record<string, any>;
    response.data.future_result_metadata = { source: "test" };
    expect(validate(schemaFile.contentSuccess, response)).toBe(true);

    const verify = loadExample("valid", "verify-success.json") as { data: { capabilities: Record<string, unknown>; site: Record<string, unknown> } };
    verify.data.capabilities.future_capability = true;
    verify.data.site.future_display_name = "test";
    expect(validate(schemaFile.verifySuccess, verify)).toBe(true);
    const channels = loadExample("valid", "channels-success.json") as { data: { channels: unknown[]; [key: string]: unknown } };
    channels.data.future_metadata = { source: "test" };
    expect(validate(schemaFile.channelsSuccess, channels)).toBe(true);
    expect(validate(schemaFile.problemDetails, {
      ...(loadExample("valid", "problem-invalid-content.json") as Record<string, unknown>),
      future_extension: "ignored",
    })).toBe(true);
  });

  it("keeps known nested structures strict and content.body non-empty", () => {
    const minimal = loadExample("valid", "content-minimal.json") as ContentBody;
    const emptyBody = clone(minimal);
    emptyBody.content = { ...(emptyBody.content ?? {}), body: "" };
    expect(validate(schemaFile.contentRequestBody, emptyBody)).toBe(false);
    const nestedUnknown = clone(minimal);
    nestedUnknown.content = { ...(nestedUnknown.content ?? {}), future: true };
    expect(validate(schemaFile.contentRequestBody, nestedUnknown)).toBe(false);
  });

  it("accepts every frozen content result and separates warnings from errors", () => {
    for (const fileName of [
      "content-created.json",
      "content-updated.json",
      "content-unchanged.json",
      "content-warning.json",
    ]) {
      expect(validate(schemaFile.contentSuccess, loadExample("valid", fileName))).toBe(
        true,
      );
    }
    expect(
      validate(
        schemaFile.problemDetails,
        loadExample("valid", "problem-invalid-content.json"),
      ),
    ).toBe(true);
  });

  it("keeps the common success envelope fixed to GOPP 1.0", () => {
    for (const fileName of [
      "verify-success.json",
      "channels-success.json",
      "channels-empty.json",
      "content-created.json",
      "content-updated.json",
      "content-unchanged.json",
      "content-warning.json",
    ]) {
      const response = loadExample("valid", fileName) as Record<string, unknown>;
      expect(response.protocol).toBe("GOPP");
      expect(response.protocol_version).toBe("1.0");
      expect(typeof response.request_id).toBe("string");
      expect(response.data).toBeTypeOf("object");
    }
  });

  it("requires draft in capabilities and permits only the frozen status subsets", () => {
    const verify = loadExample("valid", "verify-success.json") as {
      data: {
        capabilities: Record<string, unknown>;
      };
    };
    const capabilities = verify.data.capabilities;
    expect(capabilities.statuses).toEqual(["draft", "published"]);
    expect(capabilities.content_formats).toEqual(["html"]);
    expect(capabilities.upsert).toBe(true);
    expect(validate(schemaFile.verifySuccess, verify)).toBe(true);

    for (const statuses of [
      ["draft"],
      ["draft", "published"],
    ]) {
      const candidate = clone(verify);
      candidate.data.capabilities.statuses = statuses;
      expect(validate(schemaFile.verifySuccess, candidate)).toBe(true);
    }

    const publishedOnly = clone(verify);
    publishedOnly.data.capabilities.statuses = ["published"];
    expect(validate(schemaFile.verifySuccess, publishedOnly)).toBe(false);
  });

  it("represents channels=false with a valid empty channels response", () => {
    const verify = loadExample("valid", "verify-success.json") as {
      data: {
        capabilities: Record<string, unknown>;
      };
    };
    const noChannels = clone(verify);
    noChannels.data.capabilities.channels = false;
    expect(validate(schemaFile.verifySuccess, noChannels)).toBe(true);

    const emptyResponse = loadExample("valid", "channels-empty.json") as {
      data: {
        channels: unknown[];
      };
    };
    expect(emptyResponse.data.channels).toEqual([]);
    expect(validate(schemaFile.channelsSuccess, emptyResponse)).toBe(true);
    expect(protocolDocumentation).toContain("channels=false 时，data 必须为 {\"channels\":[]}");
  });
});
