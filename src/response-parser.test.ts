import { describe, it, expect } from "vitest";
import { parseResponse } from "./response-parser.js";

describe("parseResponse", () => {
  describe("JSON", () => {
    it("parses application/json", () => {
      const result = parseResponse("application/json", '{"a":1}');
      expect(result).toEqual({ a: 1 });
    });

    it("parses +json content types", () => {
      const result = parseResponse("application/vnd.api+json", '{"b":2}');
      expect(result).toEqual({ b: 2 });
    });

    it("throws on malformed JSON with json content-type", () => {
      expect(() => parseResponse("application/json", "not json")).toThrow();
    });
  });

  describe("XML", () => {
    it("parses application/xml", () => {
      const result = parseResponse("application/xml", "<root><name>test</name></root>");
      expect(result).toEqual({ root: { name: "test" } });
    });

    it("parses text/xml", () => {
      const result = parseResponse("text/xml", "<item>val</item>");
      expect(result).toEqual({ item: "val" });
    });

    it("parses +xml content types", () => {
      const result = parseResponse(
        "application/atom+xml",
        "<feed><title>test</title></feed>"
      );
      expect(result).toEqual({ feed: { title: "test" } });
    });
  });

  describe("CSV", () => {
    it("parses simple CSV with headers", () => {
      const csv = "name,age\nAlice,30\nBob,25";
      const result = parseResponse("text/csv", csv);
      expect(result).toEqual([
        { name: "Alice", age: "30" },
        { name: "Bob", age: "25" },
      ]);
    });

    it("handles quoted fields with commas", () => {
      const csv = 'name,bio\n"Smith, John","likes, coding"';
      const result = parseResponse("text/csv", csv);
      expect(result).toEqual([{ name: "Smith, John", bio: "likes, coding" }]);
    });

    it("handles escaped quotes", () => {
      const csv = 'name,quote\nAlice,"She said ""hello"""';
      const result = parseResponse("text/csv", csv);
      expect(result).toEqual([{ name: "Alice", quote: 'She said "hello"' }]);
    });

    it("returns empty array for empty CSV", () => {
      const result = parseResponse("text/csv", "");
      expect(result).toEqual([]);
    });

    it("handles application/csv content-type", () => {
      const csv = "a,b\n1,2";
      const result = parseResponse("application/csv", csv);
      expect(result).toEqual([{ a: "1", b: "2" }]);
    });
  });

  describe("text/plain and fallback", () => {
    it("parses valid JSON string with text/plain", () => {
      const result = parseResponse("text/plain", '{"x":1}');
      expect(result).toEqual({ x: 1 });
    });

    it("returns text wrapper for non-JSON text/plain", () => {
      const result = parseResponse("text/plain", "hello world");
      expect(result).toEqual({ _type: "text", content: "hello world" });
    });

    it("attempts JSON parse when content-type is null", () => {
      const result = parseResponse(null, '{"y":2}');
      expect(result).toEqual({ y: 2 });
    });

    it("returns text wrapper for null content-type with non-JSON body", () => {
      const result = parseResponse(null, "plain text");
      expect(result).toEqual({ _type: "text", content: "plain text" });
    });

    it("returns text wrapper for unknown content-type", () => {
      const result = parseResponse("application/octet-stream", "binary-ish");
      expect(result).toEqual({ _type: "text", content: "binary-ish" });
    });
  });
});
