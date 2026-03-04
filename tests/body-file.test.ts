import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBody } from "../src/body-file.js";

let tempDir: string;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "body-file-test-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("resolveBody", () => {
  it("returns undefined when neither body nor bodyFile provided", () => {
    expect(resolveBody(undefined, undefined)).toBeUndefined();
  });

  it("returns body as-is when only body provided", () => {
    const body = { name: "Alice" };
    expect(resolveBody(body, undefined)).toEqual(body);
  });

  it("reads and parses valid JSON file", () => {
    const dir = setup();
    const filePath = join(dir, "body.json");
    writeFileSync(filePath, JSON.stringify({ html_content: "<h1>Hello</h1>" }));
    const result = resolveBody(undefined, filePath);
    expect(result).toEqual({ html_content: "<h1>Hello</h1>" });
  });

  it("throws when both body and bodyFile provided", () => {
    expect(() =>
      resolveBody({ a: 1 }, "/tmp/something.json")
    ).toThrow("Cannot specify both 'body' and 'bodyFile'");
  });

  it("throws when file not found", () => {
    expect(() =>
      resolveBody(undefined, "/tmp/nonexistent-file-abc123.json")
    ).toThrow(/Failed to read bodyFile/);
    expect(() =>
      resolveBody(undefined, "/tmp/nonexistent-file-abc123.json")
    ).toThrow("nonexistent-file-abc123.json");
  });

  it("throws on invalid JSON", () => {
    const dir = setup();
    const filePath = join(dir, "bad.json");
    writeFileSync(filePath, "not json {{{");
    expect(() => resolveBody(undefined, filePath)).toThrow(/invalid JSON/);
  });

  it("throws on relative path", () => {
    expect(() =>
      resolveBody(undefined, "relative/path.json")
    ).toThrow("bodyFile must be an absolute path");
  });

  it("throws on array JSON", () => {
    const dir = setup();
    const filePath = join(dir, "array.json");
    writeFileSync(filePath, "[1, 2, 3]");
    expect(() => resolveBody(undefined, filePath)).toThrow(
      "bodyFile must contain a JSON object"
    );
  });
});
