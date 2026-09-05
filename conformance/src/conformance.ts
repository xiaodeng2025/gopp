import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
const requestTimeoutMs = 10000;
const schemaDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../spec/v1/schemas",
);

const schemaFiles = {
  verify: "verify-success.schema.json",
  channels: "channels-success.schema.json",
  content: "content-success-response.schema.json",
  problem: "problem-details.schema.json",
} as const;

export type ConformanceResult = "pass" | "fail" | "skip";

export interface ConformanceTest {
  id: string;
  result: ConformanceResult;
  detail?: string;
}

export interface ConformanceReport {
  protocol: "GOPP";
  version: "1.0";
  result: "pass" | "fail";
  summary: {
    passed: number;
    failed: number;
    skipped: number;
  };
  tests: ConformanceTest[];
}

export interface ConformanceConfig {
  baseUrl: string;
  token: string;
}

interface HttpResult {
  status: number;
  contentType: string;
  body: unknown;
}

interface Capabilities {
  content_formats: unknown;
  statuses: unknown;
  upsert: unknown;
  channels: unknown;
  tags: unknown;
  seo: unknown;
  media: unknown;
  revision: unknown;
}

class CheckFailure extends Error {}

function loadValidators(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });
  addFormats(ajv);
  for (const fileName of readdirSync(schemaDirectory).filter((name) =>
    name.endsWith(".json"),
  )) {
    const schema = JSON.parse(
      readFileSync(path.join(schemaDirectory, fileName), "utf8"),
    ) as { $id?: string };
    if (!schema.$id) {
      throw new Error("Schema " + fileName + " has no $id.");
    }
    ajv.addSchema(schema);
  }
  const validators = new Map<string, ValidateFunction>();
  for (const fileName of Object.values(schemaFiles)) {
    const schema = JSON.parse(
      readFileSync(path.join(schemaDirectory, fileName), "utf8"),
    ) as { $id: string };
    const validator = ajv.getSchema(schema.$id);
    if (!validator) {
      throw new Error("Schema " + fileName + " was not registered.");
    }
    validators.set(fileName, validator);
  }
  return validators;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("base URL must be a valid HTTP or HTTPS URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must use HTTP or HTTPS.");
  }
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CheckFailure(label + " did not return a JSON object.");
  }
  return value;
}

function contentData(value: unknown, label: string): Record<string, unknown> {
  const outer = record(value, label);
  return record(outer.data, label + " data");
}

function problemCode(value: unknown, label: string): string {
  const problem = record(value, label);
  if (typeof problem.code !== "string") {
    throw new CheckFailure(label + " did not return a machine-readable code.");
  }
  return problem.code;
}

function assertProblem(
  response: HttpResult,
  validators: Map<string, ValidateFunction>,
  label: string,
): string {
  if (response.status >= 200 && response.status < 300) {
    throw new CheckFailure(label + " unexpectedly returned success.");
  }
  if (!response.contentType.startsWith("application/problem+json")) {
    throw new CheckFailure(label + " did not use application/problem+json.");
  }
  const validator = validators.get(schemaFiles.problem);
  if (!validator || !validator(response.body)) {
    throw new CheckFailure(label + " did not return valid Problem Details.");
  }
  return problemCode(response.body, label);
}

function assertContentSuccess(
  response: HttpResult,
  validators: Map<string, ValidateFunction>,
  label: string,
): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) {
    throw new CheckFailure(label + " did not return a success response.");
  }
  if (!response.contentType.startsWith("application/json")) {
    throw new CheckFailure(label + " did not use application/json.");
  }
  const validator = validators.get(schemaFiles.content);
  if (!validator || !validator(response.body)) {
    throw new CheckFailure(label + " did not return a valid content response.");
  }
  return contentData(response.body, label);
}

function assertStatus(
  response: HttpResult,
  expected: number,
  label: string,
): void {
  if (response.status !== expected) {
    throw new CheckFailure(label + " returned an unexpected HTTP status.");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function minimalBody(): Record<string, unknown> {
  return {
    title: "GOPP Conformance Test",
    content: {
      format: "html",
      body: "<p>GOPP conformance test content.</p>",
    },
  };
}

async function request(
  config: ConformanceConfig,
  pathName: string,
  method: string,
  body: unknown | undefined,
  token: string | undefined,
  requestId: string | undefined,
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.Authorization = "Bearer " + token;
  }
  if (requestId !== undefined) {
    headers["X-Request-ID"] = requestId;
  }
  headers.Accept = "application/json";
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(config.baseUrl + pathName, init);
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

function bodyWith(
  field: string,
  value: unknown,
): Record<string, unknown> {
  const body = minimalBody();
  body[field] = value;
  return body;
}

function buildReport(tests: ConformanceTest[]): ConformanceReport {
  const passed = tests.filter((test) => test.result === "pass").length;
  const failed = tests.filter((test) => test.result === "fail").length;
  const skipped = tests.filter((test) => test.result === "skip").length;
  return {
    protocol: "GOPP",
    version: "1.0",
    result: failed === 0 ? "pass" : "fail",
    summary: {
      passed,
      failed,
      skipped,
    },
    tests,
  };
}

export async function runConformance(
  input: ConformanceConfig,
): Promise<ConformanceReport> {
  const config = {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    token: input.token,
  };
  if (!config.token) {
    throw new Error("token must be provided.");
  }
  const validators = loadValidators();
  const tests: ConformanceTest[] = [];

  const check = async (
    id: string,
    action: () => Promise<string | undefined>,
  ): Promise<boolean> => {
    try {
      const detail = await action();
      tests.push({ id, result: "pass", detail });
      return true;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "The check failed.";
      tests.push({
        id,
        result: "fail",
        detail: detail.replaceAll(config.token, "[REDACTED]"),
      });
      return false;
    }
  };

  const skip = (id: string, detail: string): void => {
    tests.push({ id, result: "skip", detail });
  };

  if (config.baseUrl.startsWith("https://")) {
    await check("transport_https", async () => undefined);
  } else {
    skip(
      "transport_https",
      "SKIP: local HTTP is allowed for conformance test environments.",
    );
  }

  await check("authentication", async () => {
    const noToken = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      undefined,
      undefined,
    );
    assertStatus(noToken, 401, "missing-token");
    assertProblem(noToken, validators, "missing-token");

    const wrongToken = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      "gopp-invalid-token",
      undefined,
    );
    assertStatus(wrongToken, 401, "wrong-token");
    assertProblem(wrongToken, validators, "wrong-token");
    return undefined;
  });

  await check("success_media_type", async () => {
    const response = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      config.token,
      undefined,
    );
    if (!response.contentType.startsWith("application/json")) {
      throw new CheckFailure("verify success media type is not application/json.");
    }
    return undefined;
  });

  await check("error_media_type", async () => {
    const response = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      undefined,
      undefined,
    );
    assertProblem(response, validators, "authentication error");
    if (!response.contentType.startsWith("application/problem+json")) {
      throw new CheckFailure("error media type is not application/problem+json.");
    }
    return undefined;
  });

  let capabilities: Capabilities | undefined;
  let channelIds: string[] = [];
  const verifyOk = await check("verify", async () => {
    const response = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      config.token,
      undefined,
    );
    assertStatus(response, 200, "verify");
    const validator = validators.get(schemaFiles.verify);
    if (!validator || !validator(response.body)) {
      throw new CheckFailure("verify response does not match its Schema.");
    }
    const outer = record(response.body, "verify response");
    if (
      outer.protocol !== "GOPP" ||
      outer.protocol_version !== "1.0" ||
      typeof outer.request_id !== "string" ||
      outer.request_id.length === 0
    ) {
      throw new CheckFailure("verify response has invalid protocol identity.");
    }
    const data = record(outer.data, "verify data");
    capabilities = record(
      data.capabilities,
      "verify capabilities",
    ) as unknown as Capabilities;
    if (
      !Array.isArray(capabilities.statuses) ||
      !capabilities.statuses.includes("draft") ||
      capabilities.upsert !== true ||
      !Array.isArray(capabilities.content_formats) ||
      !capabilities.content_formats.includes("html")
    ) {
      throw new CheckFailure("verify capabilities do not satisfy GOPP v1 minimums.");
    }
    return undefined;
  });

  if (!verifyOk || !capabilities) {
    for (const id of [
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
    ]) {
      skip(id, "SKIP: verify did not provide usable GOPP v1 capabilities.");
    }
    return buildReport(tests);
  }

  const channelsEnabled = capabilities.channels === true;
  const channelsOk = await check("channels", async () => {
    const channelsResponse = await request(
      config,
      "/v1/channels",
      "GET",
      undefined,
      config.token,
      undefined,
    );
    assertStatus(channelsResponse, 200, "channels");
    if (!channelsResponse.contentType.startsWith("application/json")) {
      throw new CheckFailure("channels did not use application/json.");
    }
    const validator = validators.get(schemaFiles.channels);
    if (!validator || !validator(channelsResponse.body)) {
      throw new CheckFailure("channels response does not match its Schema.");
    }
    const channels = contentData(channelsResponse.body, "channels").channels;
    if (!Array.isArray(channels)) {
      throw new CheckFailure("channels data is not an array.");
    }
    const ids = channels.map((item) => {
      const channel = record(item, "channel item");
      if (typeof channel.id !== "string") {
        throw new CheckFailure("channel.id is not a string.");
      }
      return channel.id;
    });
    if (new Set(ids).size !== ids.length) {
      throw new CheckFailure("channels contains duplicate channel IDs.");
    }
    if (!channelsEnabled && ids.length !== 0) {
      throw new CheckFailure("channels=false did not return an empty list.");
    }
    channelIds = ids;
    return undefined;
  });

  const minimalSourceId = "gopp-conformance-" + randomUUID();
  const minimal = minimalBody();
  const minimalOk = await check("minimal_content", async () => {
    const minimalResponse = await request(
      config,
      "/v1/content/" + encodeURIComponent(minimalSourceId),
      "PUT",
      minimal,
      config.token,
      undefined,
    );
    assertStatus(minimalResponse, 201, "minimal content");
    const data = assertContentSuccess(
      minimalResponse,
      validators,
      "minimal content",
    );
    if (data.result !== "created") {
      throw new CheckFailure("minimal content did not return created.");
    }
    return undefined;
  });

  let updatedBody: Record<string, unknown> | undefined;
  if (minimalOk) {
    const unchangedResponse = await request(
      config,
      "/v1/content/" + encodeURIComponent(minimalSourceId),
      "PUT",
      minimal,
      config.token,
      undefined,
    );
    await check("idempotency", async () => {
      assertStatus(unchangedResponse, 200, "same content");
      const data = assertContentSuccess(
        unchangedResponse,
        validators,
        "same content",
      );
      if (data.result !== "unchanged") {
        throw new CheckFailure("same content did not return unchanged.");
      }
      return undefined;
    });

    updatedBody = clone(minimal);
    updatedBody.title = "GOPP Conformance Test Updated";
    const updatedResponse = await request(
      config,
      "/v1/content/" + encodeURIComponent(minimalSourceId),
      "PUT",
      updatedBody,
      config.token,
      undefined,
    );
    const updatedOk = await check("update", async () => {
      assertStatus(updatedResponse, 200, "updated content");
      const data = assertContentSuccess(
        updatedResponse,
        validators,
        "updated content",
      );
      if (data.result !== "updated") {
        throw new CheckFailure("changed content did not return updated.");
      }
      return undefined;
    });

    if (updatedOk && updatedBody) {
      const unchangedUpdated = await request(
        config,
        "/v1/content/" + encodeURIComponent(minimalSourceId),
        "PUT",
        updatedBody,
        config.token,
        undefined,
      );
      await check("unchanged_after_update", async () => {
        assertStatus(unchangedUpdated, 200, "same updated content");
        const data = assertContentSuccess(
          unchangedUpdated,
          validators,
          "same updated content",
        );
        if (data.result !== "unchanged") {
          throw new CheckFailure(
            "repeated updated content did not return unchanged.",
          );
        }
        return undefined;
      });
    } else {
      skip("unchanged_after_update", "SKIP: update did not succeed.");
    }
  } else {
    skip("idempotency", "SKIP: minimal content was not created.");
    skip("update", "SKIP: minimal content was not created.");
    skip("unchanged_after_update", "SKIP: update dependency was not met.");
  }

  const statusSourceId = "gopp-status-" + randomUUID();
  await check("draft", async () => {
    const omittedStatusResponse = await request(
      config,
      "/v1/content/" + encodeURIComponent(statusSourceId),
      "PUT",
      minimalBody(),
      config.token,
      undefined,
    );
    assertStatus(omittedStatusResponse, 201, "omitted status");
    const createdData = assertContentSuccess(
      omittedStatusResponse,
      validators,
      "omitted status",
    );
    if (createdData.result !== "created") {
      throw new CheckFailure("omitted status did not create content.");
    }
    const explicitDraft = bodyWith("status", "draft");
    const explicitResponse = await request(
      config,
      "/v1/content/" + encodeURIComponent(statusSourceId),
      "PUT",
      explicitDraft,
      config.token,
      undefined,
    );
    assertStatus(explicitResponse, 200, "explicit draft");
    const unchangedData = assertContentSuccess(
      explicitResponse,
      validators,
      "explicit draft",
    );
    if (unchangedData.result !== "unchanged") {
      throw new CheckFailure("omitted status was not normalized to draft.");
    }
    return undefined;
  });

  const publishedBody = bodyWith("status", "published");
  if (Array.isArray(capabilities.statuses) && capabilities.statuses.includes("published")) {
    await check("published", async () => {
      const response = await request(
        config,
        "/v1/content/gopp-published-" + randomUUID(),
        "PUT",
        publishedBody,
        config.token,
        undefined,
      );
      assertStatus(response, 201, "published content");
      const data = assertContentSuccess(
        response,
        validators,
        "published content",
      );
      if (data.result !== "created") {
        throw new CheckFailure("published content did not return created.");
      }
      return undefined;
    });
  } else {
    await check("published", async () => {
      const response = await request(
        config,
        "/v1/content/gopp-published-" + randomUUID(),
        "PUT",
        publishedBody,
        config.token,
        undefined,
      );
      const code = assertProblem(response, validators, "published rejection");
      if (code === "internal_error") {
        throw new CheckFailure("published rejection returned an internal error.");
      }
      return undefined;
    });
  }

  await check("content_format", async () => {
    const htmlResponse = await request(
      config,
      "/v1/content/gopp-html-" + randomUUID(),
      "PUT",
      minimalBody(),
      config.token,
      undefined,
    );
    assertStatus(htmlResponse, 201, "html content");
    assertContentSuccess(htmlResponse, validators, "html content");

    const markdownBody = clone(minimalBody());
    const markdownContent = record(markdownBody.content, "content");
    markdownContent.format = "markdown";
    const markdownResponse = await request(
      config,
      "/v1/content/gopp-markdown-" + randomUUID(),
      "PUT",
      markdownBody,
      config.token,
      undefined,
    );
    const code = assertProblem(markdownResponse, validators, "markdown content");
    if (code !== "unsupported_content_format") {
      throw new CheckFailure("markdown content did not use unsupported_content_format.");
    }
    return undefined;
  });

  if (channelsEnabled && channelsOk && channelIds.length > 0) {
    await check("channel", async () => {
      const validBody = bodyWith("channel", { id: channelIds[0] });
      const validResponse = await request(
        config,
        "/v1/content/gopp-channel-" + randomUUID(),
        "PUT",
        validBody,
        config.token,
        undefined,
      );
      assertStatus(validResponse, 201, "valid channel");
      assertContentSuccess(validResponse, validators, "valid channel");

      const invalidBody = bodyWith("channel", {
        id: "gopp-missing-channel-" + randomUUID(),
      });
      const invalidResponse = await request(
        config,
        "/v1/content/gopp-channel-missing-" + randomUUID(),
        "PUT",
        invalidBody,
        config.token,
        undefined,
      );
      const code = assertProblem(
        invalidResponse,
        validators,
        "missing channel",
      );
      if (code !== "channel_not_found") {
        throw new CheckFailure("missing channel did not use channel_not_found.");
      }
      return undefined;
    });
  } else if (!channelsEnabled) {
    await check("channel", async () => {
      const response = await request(
        config,
        "/v1/content/gopp-channel-disabled-" + randomUUID(),
        "PUT",
        bodyWith("channel", { id: "news" }),
        config.token,
        undefined,
      );
      assertProblem(response, validators, "channel with channels=false");
      return undefined;
    });
  } else {
    skip(
      "channel",
      "SKIP: channels=true but the Receiver returned no usable channels.",
    );
  }

  const optionalCapabilities: Array<
    ["tags" | "seo" | "media", unknown]
  > = [
    ["tags", ["conformance"]],
    ["seo", { title: "GOPP Conformance SEO" }],
    ["media", { cover: { url: "https://example.com/conformance.jpg" } }],
  ];
  for (const [field, value] of optionalCapabilities) {
    if (capabilities[field] === true) {
      await check(field, async () => {
        const response = await request(
          config,
          "/v1/content/gopp-" + field + "-" + randomUUID(),
          "PUT",
          bodyWith(field, value),
          config.token,
          undefined,
        );
        assertStatus(response, 201, field);
        assertContentSuccess(response, validators, field);
        return undefined;
      });
    } else {
      await check(field, async () => {
        const response = await request(
          config,
          "/v1/content/gopp-" + field + "-disabled-" + randomUUID(),
          "PUT",
          bodyWith(field, value),
          config.token,
          undefined,
        );
        assertProblem(response, validators, field + " capability");
        return undefined;
      });
    }
  }

  if (capabilities.revision === true) {
    await check("revision", async () => {
      const sourceId = "gopp-revision-" + randomUUID();
      const revisionOne = minimalBody();
      revisionOne.revision = 1;
      const created = await request(
        config,
        "/v1/content/" + encodeURIComponent(sourceId),
        "PUT",
        revisionOne,
        config.token,
        undefined,
      );
      assertStatus(created, 201, "revision 1 create");
      assertContentSuccess(created, validators, "revision 1 create");

      const revisionTwo = clone(revisionOne);
      revisionTwo.title = "GOPP revision two";
      revisionTwo.revision = 2;
      const updated = await request(
        config,
        "/v1/content/" + encodeURIComponent(sourceId),
        "PUT",
        revisionTwo,
        config.token,
        undefined,
      );
      assertStatus(updated, 200, "revision 2 update");
      const updatedData = assertContentSuccess(
        updated,
        validators,
        "revision 2 update",
      );
      if (updatedData.result !== "updated") {
        throw new CheckFailure("higher revision did not return updated.");
      }

      const lower = clone(revisionOne);
      lower.title = "GOPP old revision";
      const lowerResponse = await request(
        config,
        "/v1/content/" + encodeURIComponent(sourceId),
        "PUT",
        lower,
        config.token,
        undefined,
      );
      if (lowerResponse.status !== 409) {
        throw new CheckFailure("lower revision did not return conflict.");
      }
      const lowerCode = assertProblem(
        lowerResponse,
        validators,
        "lower revision",
      );
      if (lowerCode !== "resource_conflict") {
        throw new CheckFailure("lower revision did not use resource_conflict.");
      }

      const sameRevision = await request(
        config,
        "/v1/content/" + encodeURIComponent(sourceId),
        "PUT",
        revisionTwo,
        config.token,
        undefined,
      );
      assertStatus(sameRevision, 200, "same revision same content");
      const sameData = assertContentSuccess(
        sameRevision,
        validators,
        "same revision same content",
      );
      if (sameData.result !== "unchanged") {
        throw new CheckFailure("same revision same content was not unchanged.");
      }

      const sameRevisionDifferent = clone(revisionTwo);
      sameRevisionDifferent.title = "GOPP same revision conflict";
      const conflict = await request(
        config,
        "/v1/content/" + encodeURIComponent(sourceId),
        "PUT",
        sameRevisionDifferent,
        config.token,
        undefined,
      );
      if (conflict.status !== 409) {
        throw new CheckFailure("same revision different content did not conflict.");
      }
      const conflictCode = assertProblem(
        conflict,
        validators,
        "same revision different content",
      );
      if (conflictCode !== "resource_conflict") {
        throw new CheckFailure(
          "same revision different content did not use resource_conflict.",
        );
      }
      return undefined;
    });
  } else {
    skip("revision", "SKIP: capabilities.revision is false.");
  }

  await check("invalid_content", async () => {
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["missing title", { content: { format: "html", body: "<p>x</p>" } }],
      ["missing content.format", { title: "x", content: { body: "<p>x</p>" } }],
      ["missing content.body", { title: "x", content: { format: "html" } }],
      [
        "negative revision",
        {
          title: "x",
          content: { format: "html", body: "<p>x</p>" },
          revision: -1,
        },
      ],
      [
        "invalid status",
        {
          title: "x",
          content: { format: "html", body: "<p>x</p>" },
          status: "archived",
        },
      ],
      [
        "relative media URL",
        {
          title: "x",
          content: { format: "html", body: "<p>x</p>" },
          media: { cover: { url: "/cover.jpg" } },
        },
      ],
    ];
    for (const [label, body] of invalidCases) {
      const response = await request(
        config,
        "/v1/content/gopp-invalid-" + randomUUID(),
        "PUT",
        body,
        config.token,
        undefined,
      );
      assertProblem(response, validators, label);
      const serialized = JSON.stringify(response.body);
      if (
        serialized.includes(config.token) ||
        serialized.includes("node_modules") ||
        serialized.includes('"stack"') ||
        /\\n\s+at\s/.test(serialized)
      ) {
        throw new CheckFailure(label + " exposed sensitive or stack details.");
      }
    }
    return undefined;
  });

  await check("request_id", async () => {
    const response = await request(
      config,
      "/v1/verify",
      "POST",
      {},
      config.token,
      "conformance-" + randomUUID(),
    );
    const outer = record(response.body, "request_id response");
    if (typeof outer.request_id !== "string" || outer.request_id.length === 0) {
      throw new CheckFailure("response did not contain a request_id.");
    }
    return undefined;
  });

  return buildReport(tests);
}

export function formatConformanceReport(report: ConformanceReport): string {
  const lines = ["GOPP v1 Conformance", ""];
  for (const test of report.tests) {
    const label = test.result.toUpperCase();
    lines.push(label + " " + test.id);
    if (test.result !== "pass" && test.detail) {
      lines.push("  " + test.detail);
    }
  }
  lines.push(
    "",
    "Result: " + report.result.toUpperCase(),
    "Summary: " +
      report.summary.passed +
      " passed, " +
      report.summary.failed +
      " failed, " +
      report.summary.skipped +
      " skipped",
  );
  return lines.join("\n");
}
