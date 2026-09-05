import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  createStoredResource,
  MemoryReceiverStorage,
  type ReceiverStorage,
  type StoredResource,
  updatedStoredResource,
} from "./receiver-storage.js";

export type { ReceiverStorage, StoredResource } from "./receiver-storage.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
const maxRequestBytes = 1024 * 1024;
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../",
);
const schemaDirectory = path.join(projectRoot, "spec", "v1", "schemas");
const sourceIdPattern = /^(?!\.\.?$)[A-Za-z0-9._~-]{1,128}$/;

export type ProtocolStatus = "draft" | "published";

export interface SiteInfo {
  name?: string;
  url?: string;
  locale?: string;
  timezone?: string;
}

export interface ReceiverCapabilities {
  content_formats: string[];
  statuses: ProtocolStatus[];
  upsert: true;
  channels: boolean;
  tags: boolean;
  seo: boolean;
  media: boolean;
  revision: boolean;
  extensions: string[];
}

export interface Channel {
  id: string;
  name: string;
  parent_id?: string | null;
}

export interface ReferenceReceiverOptions {
  token: string;
  site?: SiteInfo;
  capabilities?: Partial<ReceiverCapabilities>;
  channels?: Channel[];
  storage?: ReceiverStorage;
}

type JsonRecord = Record<string, unknown>;
type ProblemCode =
  | "authentication_failed"
  | "unsupported_protocol_version"
  | "invalid_request"
  | "invalid_content"
  | "unsupported_content_format"
  | "channel_not_found"
  | "resource_conflict"
  | "rate_limited"
  | "internal_error";

interface FieldError {
  field: string;
  reason: string;
}

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ProblemCode;
  request_id: string;
  field_errors?: FieldError[];
  retryable: boolean;
}

class ReceiverError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: ProblemCode,
    detail: string,
    public readonly retryable = false,
    public readonly fieldErrors?: FieldError[],
  ) {
    super(detail);
    this.name = "ReceiverError";
  }
}

const defaultSite: SiteInfo = {
  name: "GOPP v1 Reference Receiver",
  url: "http://127.0.0.1:8787",
  locale: "en-US",
  timezone: "UTC",
};

const defaultCapabilities: ReceiverCapabilities = {
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

const defaultChannels: Channel[] = [
  { id: "news", name: "News" },
  { id: "guides", name: "Guides" },
  { id: "cases", name: "Cases" },
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function generatedRequestId(): string {
  return "req_" + randomUUID();
}

function requestIdFrom(request: IncomingMessage): string {
  const header = request.headers["x-request-id"];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 200 &&
    !/[\u0000-\u001f\u007f\r\n]/.test(candidate)
  ) {
    return candidate;
  }
  return generatedRequestId();
}

function titleFor(code: ProblemCode): string {
  const titles: Record<ProblemCode, string> = {
    authentication_failed: "Authentication failed",
    unsupported_protocol_version: "Unsupported protocol version",
    invalid_request: "Invalid request",
    invalid_content: "Invalid content",
    unsupported_content_format: "Unsupported content format",
    channel_not_found: "Channel not found",
    resource_conflict: "Resource conflict",
    rate_limited: "Rate limited",
    internal_error: "Internal error",
  };
  return titles[code];
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: object,
  contentType = "application/json",
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": contentType + "; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function writeHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function contentFieldErrors(
  errors: ValidateFunction["errors"],
): FieldError[] | undefined {
  if (!errors || errors.length === 0) {
    return undefined;
  }
  const fields = errors.slice(0, 20).map((error) => {
    const instancePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
    if (error.keyword === "required" && "missingProperty" in error.params) {
      const missing = String(error.params.missingProperty);
      return {
        field: instancePath ? instancePath + "." + missing : missing,
        reason: "required",
      };
    }
    if (
      error.keyword === "additionalProperties" &&
      "additionalProperty" in error.params
    ) {
      return {
        field: instancePath
          ? instancePath + "." + String(error.params.additionalProperty)
          : String(error.params.additionalProperty),
        reason: "unknown_field",
      };
    }
    return {
      field: instancePath || "content",
      reason: error.keyword,
    };
  });
  return fields;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeTestHtml(value: string): string {
  const allowedTags = new Set([
    "p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li",
    "h2", "h3", "h4", "blockquote", "a",
  ]);
  return value.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => {
    const match = /^<\s*(\/)?\s*([a-zA-Z0-9]+)([^>]*)>$/i.exec(tag);
    if (!match) {
      return "";
    }
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (!allowedTags.has(name)) {
      return "";
    }
    if (closing) {
      return "</" + name + ">";
    }
    if (name !== "a") {
      return "<" + name + ">";
    }
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(match[3]);
    if (!href || !/^https?:\/\//i.test(href[2])) {
      return "<a>";
    }
    return "<a href=\"" + escapeHtml(href[2]) + "\" rel=\"noopener noreferrer\">";
  });
}

function optionalText(body: JsonRecord, field: string): string | undefined {
  return typeof body[field] === "string" ? body[field] : undefined;
}

function authorName(body: JsonRecord): string | undefined {
  const author = body.author;
  return isRecord(author) && typeof author.name === "string" ? author.name : undefined;
}

function renderTestArticle(sourceId: string, resource: StoredResource): string {
  const body = resource.body;
  const content = isRecord(body.content) ? body.content : {};
  const title = optionalText(body, "title") ?? "Untitled GOPP test article";
  const summary = optionalText(body, "summary");
  const author = authorName(body);
  const status = optionalText(body, "status") ?? "draft";
  const html = typeof content.body === "string" ? content.body : "";
  const draftNotice = status === "draft"
    ? "<p class=\"draft\">DRAFT — visible only through this test helper route.</p>"
    : "";
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + escapeHtml(title) + "</title>" +
    "<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6}.draft{background:#fff3cd;padding:.75rem;font-weight:700}.meta{color:#555;font-size:.9rem}a{color:#0759b0}</style>" +
    "</head><body><article><h1>" + escapeHtml(title) + "</h1>" + draftNotice +
    (summary ? "<p>" + escapeHtml(summary) + "</p>" : "") +
    "<div class=\"content\">" + sanitizeTestHtml(html) + "</div>" +
    "<hr><dl class=\"meta\"><dt>Status</dt><dd>" + escapeHtml(status) +
    "</dd>" + (author ? "<dt>Author</dt><dd>" + escapeHtml(author) + "</dd>" : "") +
    "<dt>Updated</dt><dd>" + escapeHtml(resource.updated_at) +
    "</dd><dt>Source ID</dt><dd>" + escapeHtml(sourceId) +
    "</dd></dl></article></body></html>";
}

function comparableBody(body: JsonRecord): JsonRecord {
  const copy = { ...body };
  delete copy.revision;
  return copy;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0].trim().toLowerCase()
      : "";
  if (mediaType !== "application/json") {
    throw new ReceiverError(
      400,
      "invalid_request",
      "Content-Type must be application/json.",
    );
  }

  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxRequestBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    request.on("error", () => {
      reject(
        new ReceiverError(
          400,
          "invalid_request",
          "The request body could not be read.",
        ),
      );
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(
          new ReceiverError(
            400,
            "invalid_request",
            "The request body exceeds the reference receiver limit.",
          ),
        );
        return;
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(
          new ReceiverError(
            400,
            "invalid_request",
            "The request body must be valid JSON.",
          ),
        );
      }
    });
  });
}

export class ReferenceReceiver {
  private readonly token: string;
  private readonly site: SiteInfo;
  private readonly capabilities: ReceiverCapabilities;
  private readonly channels: Channel[];
  private readonly storage: ReceiverStorage;
  private readonly contentValidator: ValidateFunction;

  public constructor(options: ReferenceReceiverOptions) {
    if (!options.token) {
      throw new Error("A non-empty GOPP token is required.");
    }
    this.token = options.token;
    this.site = { ...defaultSite, ...(options.site ?? {}) };
    this.capabilities = {
      ...defaultCapabilities,
      ...(options.capabilities ?? {}),
      upsert: true,
    };
    if (
      !this.capabilities.content_formats.includes("html") ||
      !this.capabilities.statuses.includes("draft")
    ) {
      throw new Error("A GOPP v1 Receiver must support html and draft.");
    }
    this.channels = [...(options.channels ?? defaultChannels)];
    this.storage = options.storage ?? new MemoryReceiverStorage();
    this.contentValidator = this.loadContentValidator();
  }

  public createServer(): Server {
    return createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public getResourceCount(): number {
    return this.storage.count();
  }

  public getStoredResource(sourceId: string): StoredResource | undefined {
    return this.storage.get(sourceId);
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = requestIdFrom(request);
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://gopp-reference.invalid",
      );
      const pathname = requestUrl.pathname;

      if (pathname === "/healthz") {
        this.handleHealth(request, response);
        return;
      }
      if (pathname.startsWith("/test/articles/")) {
        this.handleTestArticle(request, response, pathname);
        return;
      }

      if (!this.isAuthorized(request)) {
        throw new ReceiverError(
          401,
          "authentication_failed",
          "A valid Bearer token is required.",
        );
      }

      if (/^\/v\d+(?:\/|$)/.test(pathname) && !pathname.startsWith("/v1/")) {
        throw new ReceiverError(
          400,
          "unsupported_protocol_version",
          "This Receiver supports GOPP v1 only.",
        );
      }

      if (pathname === "/v1/verify") {
        await this.handleVerify(request, response, requestId);
        return;
      }
      if (pathname === "/v1/channels") {
        this.handleChannels(request, response, requestId);
        return;
      }
      if (pathname.startsWith("/v1/content/")) {
        await this.handleContent(request, response, requestId, pathname);
        return;
      }

      throw new ReceiverError(
        404,
        "invalid_request",
        "The requested GOPP route was not found.",
      );
    } catch (error) {
      this.writeError(response, requestId, error);
    }
  }

  private loadContentValidator(): ValidateFunction {
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
        throw new Error("Schema " + fileName + " must declare $id.");
      }
      ajv.addSchema(schema);
    }
    const validator = ajv.getSchema(
      "https://gopp.example/schemas/v1/content-request-body.schema.json",
    );
    if (!validator) {
      throw new Error("The GOPP content request schema is unavailable.");
    }
    return validator;
  }

  private handleHealth(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      throw new ReceiverError(405, "invalid_request", "GET is required for /healthz.");
    }
    writeJson(response, 200, { status: "ok" });
  }

  private handleTestArticle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): void {
    if (request.method !== "GET") {
      throw new ReceiverError(405, "invalid_request", "GET is required for test articles.");
    }
    const rawSourceId = pathname.slice("/test/articles/".length);
    if (!rawSourceId || rawSourceId.includes("/")) {
      throw new ReceiverError(404, "invalid_request", "The requested test article was not found.");
    }
    let sourceId: string;
    try {
      sourceId = decodeURIComponent(rawSourceId);
    } catch {
      throw new ReceiverError(404, "invalid_request", "The requested test article was not found.");
    }
    const resource = this.storage.get(sourceId);
    if (!resource) {
      throw new ReceiverError(404, "invalid_request", "The requested test article was not found.");
    }
    writeHtml(response, renderTestArticle(sourceId, resource));
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") {
      return false;
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match !== null && match[1] === this.token;
  }

  private async handleVerify(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    if (request.method !== "POST") {
      throw new ReceiverError(
        405,
        "invalid_request",
        "POST is required for /v1/verify.",
      );
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || Object.keys(body).length !== 0) {
      throw new ReceiverError(
        400,
        "invalid_request",
        "The /v1/verify request body must be an empty JSON object.",
      );
    }
    writeJson(response, 200, {
      protocol: "GOPP",
      protocol_version: "1.0",
      request_id: requestId,
      data: {
        site: this.site,
        capabilities: this.capabilities,
      },
    });
  }

  private handleChannels(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): void {
    if (request.method !== "GET") {
      throw new ReceiverError(
        405,
        "invalid_request",
        "GET is required for /v1/channels.",
      );
    }
    writeJson(response, 200, {
      protocol: "GOPP",
      protocol_version: "1.0",
      request_id: requestId,
      data: {
        channels: this.capabilities.channels ? this.channels : [],
      },
    });
  }

  private async handleContent(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    pathname: string,
  ): Promise<void> {
    if (request.method !== "PUT") {
      throw new ReceiverError(
        405,
        "invalid_request",
        "PUT is required for /v1/content/{source_id}.",
      );
    }

    const sourceId = this.decodeSourceId(pathname);
    const body = await readJsonBody(request);
    const content = this.validateContent(body);
    this.enforceCapabilities(content);
    const normalizedBody: JsonRecord = { ...content };
    if (!hasOwn(normalizedBody, "status")) {
      normalizedBody.status = "draft";
    }
    const result = this.upsert(sourceId, normalizedBody);
    writeJson(response, result.httpStatus, {
      protocol: "GOPP",
      protocol_version: "1.0",
      request_id: requestId,
      data: {
        result: result.result,
        remote_id: result.remoteId,
      },
    });
  }

  private decodeSourceId(pathname: string): string {
    const prefix = "/v1/content/";
    const rawSourceId = pathname.slice(prefix.length);
    if (!rawSourceId || rawSourceId.includes("/")) {
      throw new ReceiverError(
        400,
        "invalid_request",
        "source_id must be one non-empty URI path segment.",
      );
    }
    let sourceId: string;
    try {
      sourceId = decodeURIComponent(rawSourceId);
    } catch {
      throw new ReceiverError(
        400,
        "invalid_request",
        "source_id is not valid URI-encoded text.",
      );
    }
    if (!sourceIdPattern.test(sourceId)) {
      throw new ReceiverError(
        400,
        "invalid_request",
        "source_id does not satisfy the GOPP wire grammar.",
      );
    }
    return sourceId;
  }

  private validateContent(body: unknown): JsonRecord {
    if (
      isRecord(body) &&
      isRecord(body.content) &&
      typeof body.content.format === "string" &&
      !this.capabilities.content_formats.includes(body.content.format)
    ) {
      throw new ReceiverError(
        415,
        "unsupported_content_format",
        "The requested content format is not supported by this Receiver.",
        false,
        [{ field: "content.format", reason: "unsupported" }],
      );
    }
    if (!this.contentValidator(body)) {
      throw new ReceiverError(
        422,
        "invalid_content",
        "The request does not satisfy the GOPP v1 content schema.",
        false,
        contentFieldErrors(this.contentValidator.errors),
      );
    }
    return body as JsonRecord;
  }

  private enforceCapabilities(body: JsonRecord): void {
    if (
      body.status === "published" &&
      !this.capabilities.statuses.includes("published")
    ) {
      throw new ReceiverError(
        422,
        "invalid_content",
        "This Receiver does not support the published status.",
        false,
        [{ field: "status", reason: "capability_not_supported" }],
      );
    }

    const capabilityFields: Array<
      ["tags" | "seo" | "media" | "revision", string]
    > = [
      ["tags", "tags"],
      ["seo", "seo"],
      ["media", "media"],
      ["revision", "revision"],
    ];
    for (const [capability, field] of capabilityFields) {
      if (hasOwn(body, field) && !this.capabilities[capability]) {
        throw new ReceiverError(
          422,
          "invalid_content",
          "The Receiver does not support the explicitly supplied " +
            field +
            " capability.",
          false,
          [{ field, reason: "capability_not_supported" }],
        );
      }
    }

    if (hasOwn(body, "channel")) {
      if (!this.capabilities.channels) {
        throw new ReceiverError(
          422,
          "invalid_content",
          "This Receiver does not support channel assignment.",
          false,
          [{ field: "channel", reason: "capability_not_supported" }],
        );
      }
      const channel = body.channel as JsonRecord;
      const channelId = channel.id;
      if (
        typeof channelId !== "string" ||
        !this.channels.some((item) => item.id === channelId)
      ) {
        throw new ReceiverError(
          404,
          "channel_not_found",
          "channel.id does not identify a current Receiver channel.",
          false,
          [{ field: "channel.id", reason: "not_found" }],
        );
      }
    }
  }

  private upsert(
    sourceId: string,
    body: JsonRecord,
  ): {
    result: "created" | "updated" | "unchanged";
    httpStatus: number;
    remoteId: string;
  } {
    const incomingRevision =
      typeof body.revision === "number" ? body.revision : undefined;
    const existing = this.storage.get(sourceId);
    if (!existing) {
      const resource = createStoredResource(body, incomingRevision);
      this.storage.create(sourceId, resource);
      return { result: "created", httpStatus: 201, remoteId: resource.remote_id };
    }

    const sameContent = isDeepStrictEqual(
      comparableBody(existing.body),
      comparableBody(body),
    );
    if (
      this.capabilities.revision &&
      incomingRevision !== undefined &&
      existing.revision !== undefined
    ) {
      if (incomingRevision < existing.revision) {
        throw new ReceiverError(
          409,
          "resource_conflict",
          "The supplied revision is lower than the accepted revision.",
        );
      }
      if (incomingRevision === existing.revision && !sameContent) {
        throw new ReceiverError(
          409,
          "resource_conflict",
          "The supplied revision is already used for different content.",
        );
      }
    }

    if (sameContent) {
      if (
        incomingRevision !== undefined &&
        (existing.revision === undefined || incomingRevision > existing.revision)
      ) {
        this.storage.replace(
          sourceId,
          updatedStoredResource(existing, body, incomingRevision),
        );
      }
      return {
        result: "unchanged",
        httpStatus: 200,
        remoteId: existing.remote_id,
      };
    }

    this.storage.replace(
      sourceId,
      updatedStoredResource(existing, body, incomingRevision),
    );
    return {
      result: "updated",
      httpStatus: 200,
      remoteId: existing.remote_id,
    };
  }

  private writeError(
    response: ServerResponse,
    requestId: string,
    error: unknown,
  ): void {
    const receiverError =
      error instanceof ReceiverError
        ? error
        : new ReceiverError(
            500,
            "internal_error",
            "The Receiver could not complete the request.",
            true,
          );
    const problem: ProblemDetails = {
      type: "about:blank",
      title: titleFor(receiverError.code),
      status: receiverError.status,
      detail: receiverError.message,
      instance: "urn:request:" + requestId,
      code: receiverError.code,
      request_id: requestId,
      retryable: receiverError.retryable,
    };
    if (receiverError.fieldErrors) {
      problem.field_errors = receiverError.fieldErrors;
    }
    writeJson(
      response,
      receiverError.status,
      problem,
      "application/problem+json",
    );
  }
}

export function createReferenceServer(
  options: ReferenceReceiverOptions,
): Server {
  return new ReferenceReceiver(options).createServer();
}
