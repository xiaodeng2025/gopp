import { describe, expect, it } from "vitest";
import {
  loadExample,
  schemaFile,
  validate,
} from "./helpers.js";

const validCases: Array<[string, string, "valid"]> = [
  ["verify-success.json", schemaFile.verifySuccess, "valid"],
  ["channels-success.json", schemaFile.channelsSuccess, "valid"],
  ["channels-empty.json", schemaFile.channelsSuccess, "valid"],
  ["content-minimal.json", schemaFile.contentRequestBody, "valid"],
  ["content-full.json", schemaFile.contentRequestBody, "valid"],
  ["content-created.json", schemaFile.contentSuccess, "valid"],
  ["content-updated.json", schemaFile.contentSuccess, "valid"],
  ["content-unchanged.json", schemaFile.contentSuccess, "valid"],
  ["content-warning.json", schemaFile.contentSuccess, "valid"],
  ["problem-invalid-content.json", schemaFile.problemDetails, "valid"],
];

const invalidCases: Array<[string, string, "invalid"]> = [
  ["missing-title.json", schemaFile.contentRequestBody, "invalid"],
  ["missing-content-format.json", schemaFile.contentRequestBody, "invalid"],
  ["missing-content-body.json", schemaFile.contentRequestBody, "invalid"],
  ["unsupported-status.json", schemaFile.contentRequestBody, "invalid"],
  ["negative-revision.json", schemaFile.contentRequestBody, "invalid"],
  ["relative-media-url.json", schemaFile.contentRequestBody, "invalid"],
  ["invalid-channel-id-type.json", schemaFile.contentRequestBody, "invalid"],
  ["malformed-problem-details.json", schemaFile.problemDetails, "invalid"],
];

describe("GOPP v1 schema fixtures", () => {
  it.each(validCases)("accepts valid fixture %s", (fileName, schemaName, kind) => {
    expect(validate(schemaName, loadExample(kind, fileName))).toBe(true);
  });

  it.each(invalidCases)("rejects invalid fixture %s", (fileName, schemaName, kind) => {
    expect(validate(schemaName, loadExample(kind, fileName))).toBe(false);
  });
});
