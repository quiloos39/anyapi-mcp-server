import { describe, it, expect } from "vitest";
import { detectPlaceholders } from "../src/body-validation.js";
import type { RequestBodySchema } from "../src/types.js";

describe("detectPlaceholders", () => {
  it("warns on PLACEHOLDER in html_content", () => {
    const warnings = detectPlaceholders({ html_content: "PLACEHOLDER" });
    expect(warnings.length).toBe(1);
    expect(warnings[0].field).toBe("html_content");
    expect(warnings[0].reason).toMatch(/Suspicious keyword/);
  });

  it("warns on file:// in body field", () => {
    const warnings = detectPlaceholders({ body: "file:///tmp/x.html" });
    expect(warnings.length).toBe(1);
    expect(warnings[0].field).toBe("body");
    expect(warnings[0].reason).toMatch(/Suspicious pattern/);
  });

  it("warns on angle-bracket placeholder in html", () => {
    const warnings = detectPlaceholders({ html: "<your content>" });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].field).toBe("html");
  });

  it("warns on short content for HTML field with schema hint", () => {
    const schema: RequestBodySchema = {
      contentType: "application/json",
      properties: {
        html_content: {
          type: "string",
          description: "The HTML content of the email template",
        },
      },
    };
    const warnings = detectPlaceholders({ html_content: "hi" }, schema);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.reason.includes("short"))).toBe(true);
  });

  it("no warnings for normal data", () => {
    const warnings = detectPlaceholders({
      name: "Alice",
      email: "a@b.com",
    });
    expect(warnings.length).toBe(0);
  });

  it("no warnings for long html_content", () => {
    const longHtml = "<html>" + "x".repeat(500) + "</html>";
    const warnings = detectPlaceholders({ html_content: longHtml });
    expect(warnings.length).toBe(0);
  });

  it("no warning for 'TODO list app' in title (not a content field)", () => {
    // title is not in the content-field set, and body has only 1 key
    // but "TODO list app" is not an exact keyword match (has extra words)
    const warnings = detectPlaceholders({ title: "TODO list app" });
    expect(warnings.length).toBe(0);
  });

  it("no warnings for empty body", () => {
    expect(detectPlaceholders({})).toEqual([]);
  });

  it("no warnings for undefined body", () => {
    expect(detectPlaceholders(undefined)).toEqual([]);
  });

  it("warns on TODO in content field", () => {
    const warnings = detectPlaceholders({ content: "TODO" });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].reason).toMatch(/Suspicious keyword/);
  });

  it("warns on FIXME in a small body", () => {
    const warnings = detectPlaceholders({ data: "FIXME" });
    expect(warnings.length).toBe(1);
    expect(warnings[0].field).toBe("data");
  });

  it("warns on bracket placeholder in content field", () => {
    const warnings = detectPlaceholders({ template: "[INSERT HTML HERE]" });
    expect(warnings.length).toBe(1);
    expect(warnings[0].reason).toMatch(/Suspicious pattern/);
  });

  it("detects placeholder in nested object (1 level)", () => {
    const warnings = detectPlaceholders({
      email: { html_content: "PLACEHOLDER" },
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0].field).toBe("email.html_content");
  });

  it("warns on case-insensitive keyword match", () => {
    const warnings = detectPlaceholders({ html: "placeholder" });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});
