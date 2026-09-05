import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const schemaDirectory = path.join(projectRoot, "spec", "v1", "schemas");
const defaultTimeoutMs = 10_000;
const defaultMaxRetries = 2;
const jsonContentType = "application/json";
const problemContentType = "application/problem+json";

export type ProtocolStatus = "draft" | "published";
export type ContentResultValue = "created" | "updated" | "unchanged";
export type GoppProblemCode =
  | "authentication_failed"
  | "unsupported_protocol_version"
  | "invalid_request"
  | "invalid_content"
  | "unsupported_content_format"
  | "channel_not_found"
  | "resource_conflict"
  | "rate_limited"
  | "internal_error";

export interface SiteInfo {
  name?: string;
  url?: string;
  locale?: string;
  timezone?: string;
}

export interface Capabilities {
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

export interface ContentInput {
  title: string;
  content: {
    format: "html";
    body: string;
  };
  [field: string]: unknown;
}

export interface Warning {
  code: string;
  field?: string;
  message?: string;
}

export interface VerifyResult {
  protocol: "GOPP";
  protocol_version: "1.0";
  request_id: string;
  site: SiteInfo;
  capabilities: Capabilities;
}

export interface ContentResult {
  result: ContentResultValue;
  remote_id?: string;
  remote_url?: string;
  warnings?: Warning[];
  request_id: string;
}

export interface GoppFieldError {
  field: string;
  reason: string;
  value?: unknown;
}

export interface GoppProblem {
  type: string;
  title: string;
  status: number;
  code: GoppProblemCode;
  request_id: string;
  retryable: boolean;
  detail?: string;
  instance?: string;
  field_errors?: GoppFieldError[];
}

export type GoppErrorKind =
  | "transport"
  | "transport_security"
  | "protocol"
  | "invalid_response"
  | "local_validation";

export class GoppError extends Error {
  public constructor(
    message: string,
    public readonly kind: GoppErrorKind,
    public readonly requestId?: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly detail?: string,
    public readonly retryable?: boolean,
    public readonly fieldErrors?: GoppFieldError[],
  ) {
    super(message);
    this.name = "GoppError";
  }
}

export class TransportError extends GoppError {
  public constructor(requestId: string, timedOut = false) {
    super(
      timedOut
        ? "GOPP request timed out."
        : "GOPP transport request failed.",
      "transport",
      requestId,
    );
    this.name = "TransportError";
  }
}

export type GoppTransportSecurityCode =
  | "insecure_scheme"
  | "redirect_blocked"
  | "blocked_target";

export class GoppTransportSecurityError extends GoppError {
  public constructor(
    code: GoppTransportSecurityCode,
    requestId?: string,
  ) {
    super(
      "GOPP transport security policy blocked the request (" + code + ").",
      "transport_security",
      requestId,
      undefined,
      code,
      undefined,
      false,
    );
    this.name = "GoppTransportSecurityError";
  }
}

export class GoppProtocolError extends GoppError {
  public readonly problem: GoppProblem;

  public constructor(problem: GoppProblem) {
    super(
      "GOPP Receiver rejected the request (" + problem.code + ").",
      "protocol",
      problem.request_id,
      problem.status,
      problem.code,
      problem.detail,
      problem.retryable,
      problem.field_errors,
    );
    this.name = "GoppProtocolError";
    this.problem = problem;
  }
}

export class InvalidResponseError extends GoppError {
  public constructor(requestId: string, reason = "invalid response") {
    super("GOPP Receiver returned an " + reason + ".", "invalid_response", requestId);
    this.name = "InvalidResponseError";
  }
}

export class LocalValidationError extends GoppError {
  public constructor(
    code: string,
    fieldErrors?: GoppFieldError[],
    message = "The GOPP request failed local validation.",
  ) {
    super(message, "local_validation", undefined, undefined, code, undefined, false, fieldErrors);
    this.name = "LocalValidationError";
  }
}

export interface GoppClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  transportSecurity?: TransportSecurityOptions;
}

export interface TransportSecurityOptions {
  requireHttps?: boolean;
  allowPrivateNetwork?: boolean;
  allowedHosts?: string[];
}

export const LOCAL_TEST_TRANSPORT_SECURITY = {
  requireHttps: false,
  allowPrivateNetwork: true,
} as const;

export interface VerifyOptions {
  force?: boolean;
  requestId?: string;
}

export interface RequestOptions {
  requestId?: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface NormalizedTransportSecurity {
  requireHttps: boolean;
  allowPrivateNetwork: boolean;
  allowedHosts?: ReadonlySet<string>;
}

interface VerifyEnvelope {
  protocol: "GOPP";
  protocol_version: "1.0";
  request_id: string;
  data: {
    site: SiteInfo;
    capabilities: Capabilities;
  };
}

interface ChannelsEnvelope {
  data: {
    channels: Channel[];
  };
}

interface ContentEnvelope {
  request_id: string;
  data: {
    result: ContentResultValue;
    remote_id?: string;
    remote_url?: string;
    warnings?: Warning[];
  };
}

type ValidatorName =
  | "contentRequest"
  | "verifySuccess"
  | "channelsSuccess"
  | "contentSuccess"
  | "problemDetails";

const validators = loadValidators();

function loadValidators(): Record<ValidatorName, ValidateFunction> {
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

  const schemaFiles: Record<ValidatorName, string> = {
    contentRequest: "content-request-body.schema.json",
    verifySuccess: "verify-success.schema.json",
    channelsSuccess: "channels-success.schema.json",
    contentSuccess: "content-success-response.schema.json",
    problemDetails: "problem-details.schema.json",
  };
  const result = {} as Record<ValidatorName, ValidateFunction>;
  for (const [name, fileName] of Object.entries(schemaFiles) as Array<
    [ValidatorName, string]
  >) {
    const schema = JSON.parse(
      readFileSync(path.join(schemaDirectory, fileName), "utf8"),
    ) as { $id?: string };
    const validator = schema.$id ? ajv.getSchema(schema.$id) : undefined;
    if (!validator) {
      throw new Error("Schema " + fileName + " is unavailable.");
    }
    result[name] = validator;
  }
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function generatedRequestId(): string {
  return "req_" + randomUUID();
}

function requestId(value: string | undefined): string {
  if (
    value !== undefined &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f\r\n]/.test(value)
  ) {
    return value;
  }
  if (value !== undefined) {
    throw new LocalValidationError("invalid_request_id");
  }
  return generatedRequestId();
}

function fieldPath(error: ErrorObject): string {
  const instancePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (error.keyword === "required" && "missingProperty" in error.params) {
    const missing = String(error.params.missingProperty);
    return instancePath ? instancePath + "." + missing : missing;
  }
  if (
    error.keyword === "additionalProperties" &&
    "additionalProperty" in error.params
  ) {
    const additional = String(error.params.additionalProperty);
    return instancePath ? instancePath + "." + additional : additional;
  }
  return instancePath || "content";
}

function validationFields(
  errors: ErrorObject[] | null | undefined,
): GoppFieldError[] | undefined {
  if (!errors || errors.length === 0) {
    return undefined;
  }
  return errors.slice(0, 20).map((error) => ({
    field: fieldPath(error),
    reason:
      error.keyword === "additionalProperties"
        ? "unknown_field"
        : error.keyword === "required"
          ? "required"
          : error.keyword,
  }));
}

function contentTypeIs(response: Response, expected: string): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return false;
  }
  return contentType.split(";", 1)[0].trim().toLowerCase() === expected;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 2_147_483_647);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 2_147_483_647));
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(100 * 2 ** attempt, 2_147_483_647);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redactValue(value: unknown, token: string): unknown {
  if (typeof value === "string") {
    return value.split(token).join("[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, token));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, token),
      ]),
    );
  }
  return value;
}

function safeProblem(value: GoppProblem, token: string): GoppProblem {
  return redactValue(value, token) as GoppProblem;
}

function invalidResponse(
  requestIdValue: string,
  reason: string,
): InvalidResponseError {
  return new InvalidResponseError(requestIdValue, reason);
}

export class GoppClient {
  private readonly baseUrl: string;
  private readonly targetHost: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent?: string;
  private readonly transportSecurity: NormalizedTransportSecurity;
  private verifyCache?: VerifyResult;
  private verifyInFlight?: Promise<VerifyResult>;

  public constructor(options: GoppClientOptions) {
    this.transportSecurity = normalizeTransportSecurity(options.transportSecurity);
    const target = normalizeBaseUrl(options.baseUrl, this.transportSecurity);
    this.baseUrl = target.baseUrl;
    this.targetHost = target.host;
    if (typeof options.token !== "string" || options.token.length === 0) {
      throw new LocalValidationError("invalid_token");
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxRetries = options.maxRetries ?? defaultMaxRetries;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0
    ) {
      throw new LocalValidationError("invalid_client_options");
    }
    if (options.userAgent !== undefined) {
      if (
        options.userAgent.length === 0 ||
        /[\u0000-\u001f\u007f\r\n]/.test(options.userAgent)
      ) {
        throw new LocalValidationError("invalid_user_agent");
      }
      this.userAgent = options.userAgent;
    }
  }

  public async verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    if (!options.force && this.verifyCache) {
      return this.verifyCache;
    }
    if (!options.force && this.verifyInFlight) {
      return this.verifyInFlight;
    }

    const pending = this.request<VerifyEnvelope>({
      method: "POST",
      path: "/v1/verify",
      body: {},
      validator: "verifySuccess",
      requestId: requestId(options.requestId),
    }).then((envelope) => {
      const result: VerifyResult = {
        protocol: envelope.protocol,
        protocol_version: envelope.protocol_version,
        request_id: envelope.request_id,
        site: envelope.data.site,
        capabilities: envelope.data.capabilities,
      };
      this.verifyCache = result;
      return result;
    });

    if (!options.force) {
      this.verifyInFlight = pending;
    }
    try {
      return await pending;
    } finally {
      if (!options.force && this.verifyInFlight === pending) {
        this.verifyInFlight = undefined;
      }
    }
  }

  public async getChannels(options: RequestOptions = {}): Promise<Channel[]> {
    const verified = await this.verify();
    if (!verified.capabilities.channels) {
      return [];
    }
    const envelope = await this.request<ChannelsEnvelope>({
      method: "GET",
      path: "/v1/channels",
      validator: "channelsSuccess",
      requestId: requestId(options.requestId),
    });
    return envelope.data.channels;
  }

  public async putContent(
    sourceId: string,
    content: ContentInput,
    options: RequestOptions = {},
  ): Promise<ContentResult> {
    if (
      typeof sourceId !== "string" ||
      sourceId.length === 0 ||
      /[\u0000-\u001f\u007f\r\n]/.test(sourceId)
    ) {
      throw new LocalValidationError("invalid_source_id");
    }
    let encodedSourceId: string;
    try {
      encodedSourceId = encodeURIComponent(sourceId);
    } catch {
      throw new LocalValidationError("invalid_source_id");
    }
    const validatedContent = this.validateContent(content);
    const verified = await this.verify();
    this.validateCapabilities(validatedContent, verified.capabilities);

    const envelope = await this.request<ContentEnvelope>({
      method: "PUT",
      path: "/v1/content/" + encodedSourceId,
      body: validatedContent,
      validator: "contentSuccess",
      requestId: requestId(options.requestId),
    });
    return {
      ...envelope.data,
      request_id: envelope.request_id,
    };
  }

  private validateContent(content: ContentInput): JsonRecord {
    const validator = validators.contentRequest;
    if (!validator(content)) {
      throw new LocalValidationError(
        "invalid_content",
        validationFields(validator.errors),
      );
    }
    return content as JsonRecord;
  }

  private validateCapabilities(
    content: JsonRecord,
    capabilities: Capabilities,
  ): void {
    const nestedContent = content.content as JsonRecord;
    const format = nestedContent.format;
    if (
      typeof format !== "string" ||
      !capabilities.content_formats.includes(format)
    ) {
      throw new LocalValidationError(
        "unsupported_content_format",
        [{ field: "content.format", reason: "capability_not_supported" }],
      );
    }

    const status = hasOwn(content, "status") ? content.status : "draft";
    if (
      status === "published" &&
      !capabilities.statuses.includes("published")
    ) {
      throw new LocalValidationError(
        "invalid_content",
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
      if (hasOwn(content, field) && !capabilities[capability]) {
        throw new LocalValidationError(
          "invalid_content",
          [{ field, reason: "capability_not_supported" }],
        );
      }
    }

    if (hasOwn(content, "channel") && !capabilities.channels) {
      throw new LocalValidationError(
        "invalid_content",
        [{ field: "channel", reason: "capability_not_supported" }],
      );
    }
  }

  private endpoint(pathname: string): string {
    return this.baseUrl + pathname;
  }

  private async request<T>(options: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: JsonRecord;
    validator: ValidatorName;
    requestId: string;
  }): Promise<T> {
    let serializedBody: string | undefined;
    if (options.body !== undefined) {
      try {
        serializedBody = JSON.stringify(options.body);
      } catch {
        throw new LocalValidationError("invalid_content");
      }
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.assertEgressAllowed(options.requestId);
      let response: Response;
      try {
        const headers: Record<string, string> = {
          Accept:
            options.validator === "problemDetails"
              ? problemContentType
              : jsonContentType,
          Authorization: "Bearer " + this.token,
          "X-Request-ID": options.requestId,
        };
        if (serializedBody !== undefined) {
          headers["Content-Type"] = jsonContentType;
        }
        if (this.userAgent !== undefined) {
          headers["User-Agent"] = this.userAgent;
        }
        response = await fetch(this.endpoint(options.path), {
          method: options.method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "manual",
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await wait(backoffMs(attempt));
          continue;
        }
        throw new TransportError(options.requestId, isTimeoutError(error));
      }

      if (response.status >= 300 && response.status < 400) {
        throw new GoppTransportSecurityError(
          "redirect_blocked",
          options.requestId,
        );
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        if (attempt < this.maxRetries) {
          await wait(retryAfterMs(response) ?? backoffMs(attempt));
          continue;
        }
        throw new TransportError(options.requestId, isTimeoutError(error));
      }

      const retryableStatus = response.status === 429 || response.status === 503;
      const parsedBody = parseJson(rawBody);
      const validProblem =
        contentTypeIs(response, problemContentType) &&
        parsedBody.ok &&
        validators.problemDetails(parsedBody.value);
      const retryableProblem =
        validProblem &&
        parsedBody.ok &&
        isRecord(parsedBody.value) &&
        parsedBody.value.retryable === true;

      if (retryableStatus || retryableProblem) {
        if (attempt < this.maxRetries) {
          await wait(retryAfterMs(response) ?? backoffMs(attempt));
          continue;
        }
      }

      if (response.status < 200 || response.status >= 300) {
        if (!validProblem) {
          throw invalidResponse(options.requestId, "invalid error response");
        }
        throw new GoppProtocolError(
          safeProblem(parsedBody.value as GoppProblem, this.token),
        );
      }

      if (!contentTypeIs(response, jsonContentType) || !parsedBody.ok) {
        throw invalidResponse(options.requestId, "invalid JSON response");
      }
      const validator = validators[options.validator];
      if (!validator(parsedBody.value)) {
        throw invalidResponse(options.requestId, "malformed success response");
      }
      return parsedBody.value as T;
    }

    throw new TransportError(options.requestId);
  }

  private async assertEgressAllowed(requestIdValue: string): Promise<void> {
    if (this.transportSecurity.allowedHosts?.has(this.targetHost) === false) {
      throw new GoppTransportSecurityError("blocked_target", requestIdValue);
    }
    if (!this.transportSecurity.allowPrivateNetwork &&
      (isBlockedHostname(this.targetHost) || isBlockedIpAddress(this.targetHost))) {
      throw new GoppTransportSecurityError("blocked_target", requestIdValue);
    }
    if (isIP(this.targetHost) !== 0) {
      return;
    }
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(this.targetHost, { all: true, verbatim: true });
    } catch {
      throw new TransportError(requestIdValue);
    }
    if (addresses.length === 0 || (!this.transportSecurity.allowPrivateNetwork &&
      addresses.some((item) => isBlockedIpAddress(item.address)))) {
      throw new GoppTransportSecurityError("blocked_target", requestIdValue);
    }
  }
}

function normalizeBaseUrl(
  value: string,
  policy: NormalizedTransportSecurity,
): { baseUrl: string; host: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalValidationError("invalid_base_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalValidationError("invalid_base_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" || parsed.search) {
    throw new LocalValidationError("invalid_base_url");
  }
  const host = normalizeHostname(parsed.hostname);
  if (!isValidHostname(host)) {
    throw new LocalValidationError("invalid_base_url");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new GoppTransportSecurityError("blocked_target");
  }
  if (policy.requireHttps && parsed.protocol !== "https:") {
    throw new GoppTransportSecurityError("insecure_scheme");
  }
  if (policy.allowedHosts?.has(host) === false) {
    throw new GoppTransportSecurityError("blocked_target");
  }
  if (!policy.allowPrivateNetwork && (isBlockedHostname(host) || isBlockedIpAddress(host))) {
    throw new GoppTransportSecurityError("blocked_target");
  }
  return { baseUrl: parsed.href.replace(/\/+$/, ""), host };
}

function normalizeTransportSecurity(
  options: TransportSecurityOptions | undefined,
): NormalizedTransportSecurity {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new LocalValidationError("invalid_client_options");
  }
  const requireHttps = options?.requireHttps ?? true;
  const allowPrivateNetwork = options?.allowPrivateNetwork ?? false;
  if (typeof requireHttps !== "boolean" || typeof allowPrivateNetwork !== "boolean") {
    throw new LocalValidationError("invalid_client_options");
  }
  let allowedHosts: ReadonlySet<string> | undefined;
  if (options?.allowedHosts !== undefined) {
    if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
      throw new LocalValidationError("invalid_client_options");
    }
    const normalized = options.allowedHosts.map((host) => {
      if (typeof host !== "string") {
        throw new LocalValidationError("invalid_client_options");
      }
      const result = normalizeHostname(host);
      if (!isValidHostname(result) || /[/:?#@]/.test(host)) {
        throw new LocalValidationError("invalid_client_options");
      }
      return result;
    });
    allowedHosts = new Set(normalized);
  }
  return { requireHttps, allowPrivateNetwork, allowedHosts };
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isValidHostname(host: string): boolean {
  if (isIP(host) !== 0) {
    return true;
  }
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  return host.split(".").every((label) =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

function isBlockedHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19));
  }
  if (family !== 6) {
    return false;
  }
  const normalized = address.toLowerCase();
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedIpv4) {
    return isBlockedIpAddress(mappedIpv4[1]);
  }
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("ff");
}
