import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const schemaDirectory = path.join(projectRoot, "spec", "v1", "schemas");
const examplesDirectory = path.join(projectRoot, "spec", "v1", "examples");

export const schemaFile = {
  verifySuccess: "verify-success.schema.json",
  channelsSuccess: "channels-success.schema.json",
  contentRequestBody: "content-request-body.schema.json",
  contentSuccess: "content-success-response.schema.json",
  problemDetails: "problem-details.schema.json",
} as const;

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
    throw new Error("Schema " + fileName + " must declare $id");
  }
  ajv.addSchema(schema);
}

const validators = new Map<string, ValidateFunction>();

export function validate(schemaName: string, value: unknown): boolean {
  let validator = validators.get(schemaName);
  if (!validator) {
    const schemaPath = path.join(schemaDirectory, schemaName);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { $id: string };
    validator = ajv.getSchema(schema.$id);
    if (!validator) {
      throw new Error("Schema " + schemaName + " was not registered");
    }
    validators.set(schemaName, validator);
  }
  return validator(value);
}

export function loadExample(
  kind: "valid" | "invalid",
  fileName: string,
): unknown {
  return JSON.parse(
    readFileSync(path.join(examplesDirectory, kind, fileName), "utf8"),
  ) as unknown;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const protocolDocumentation = readFileSync(
  path.join(projectRoot, "spec", "GOPP_V1.md"),
  "utf8",
);
