import { describe, it } from "node:test";
import assert from "node:assert";
import {
  contentDisposition,
  escapeHtml,
  sanitizeFilename,
  sanitizeUnicodeFilename,
  formatFileSize,
} from "../src/utils/sanitize.js";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    assert.strictEqual(escapeHtml("a & b"), "a &amp; b");
  });

  it("escapes less than", () => {
    assert.strictEqual(escapeHtml("a < b"), "a &lt; b");
  });

  it("escapes greater than", () => {
    assert.strictEqual(escapeHtml("a > b"), "a &gt; b");
  });

  it("escapes double quote", () => {
    assert.strictEqual(escapeHtml('a " b'), "a &quot; b");
  });

  it("escapes single quote", () => {
    assert.strictEqual(escapeHtml("a ' b"), "a &#x27; b");
  });

  it("escapes all special chars", () => {
    assert.strictEqual(
      escapeHtml('<script>alert("xss")</script>'),
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("leaves normal text unchanged", () => {
    assert.strictEqual(
      escapeHtml("Hello, World! 123"),
      "Hello, World! 123",
    );
  });

  it("handles empty string", () => {
    assert.strictEqual(escapeHtml(""), "");
  });
});

describe("sanitizeFilename", () => {
  it("replaces non-alphanumeric chars with underscore", () => {
    assert.strictEqual(
      sanitizeFilename("file name (1).pdf"),
      "file_name__1_.pdf",
    );
  });

  it("preserves valid chars", () => {
    assert.strictEqual(
      sanitizeFilename("my-file_123.txt"),
      "my-file_123.txt",
    );
  });

  it("strips leading dots", () => {
    assert.strictEqual(sanitizeFilename(".hidden"), "hidden");
  });

  it("returns 'download' for empty result", () => {
    assert.strictEqual(sanitizeFilename("...."), "download");
  });

  it("truncates to 255 chars", () => {
    const long = "a".repeat(300) + ".txt";
    const result = sanitizeFilename(long);
    assert.strictEqual(result.length, 255);
  });

  it("handles Japanese characters", () => {
    const result = sanitizeFilename("写真2024.jpg");
    assert.match(result, /^[a-zA-Z0-9._-]+$/);
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    assert.strictEqual(formatFileSize(500), "500 B");
  });

  it("formats kilobytes", () => {
    assert.strictEqual(formatFileSize(2048), "2.0 KB");
  });

  it("formats megabytes", () => {
    assert.strictEqual(formatFileSize(5 * 1024 * 1024), "5.0 MB");
  });

  it("formats gigabytes", () => {
    assert.strictEqual(
      formatFileSize(2 * 1024 * 1024 * 1024),
      "2.0 GB",
    );
  });
});

describe("contentDisposition", () => {
  it("preserves a safe UTF-8 filename and supplies an ASCII fallback", () => {
    const value = contentDisposition("attachment", "不具合 写真.jpg");
    assert.match(value, /^attachment; filename="/);
    assert.match(value, /filename\*=UTF-8''%E4%B8%8D%E5%85%B7%E5%90%88%20%E5%86%99%E7%9C%9F\.jpg$/);
  });

  it("removes path and control characters", () => {
    assert.strictEqual(sanitizeUnicodeFilename("../bad\\name\n.jpg"), "bad_name_.jpg");
  });
});
