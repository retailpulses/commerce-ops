import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkFormCompleteness } from "../src/logic/form-validation";

describe("checkFormCompleteness", () => {
  it("returns complete when form has images and description", () => {
    const result = checkFormCompleteness({
      Attachments: [{ url: "https://example.com/img.jpg" }],
      Description: "商品が破損していました",
    });
    assert.equal(result.isComplete, true);
    assert.equal(result.hasImages, true);
    assert.equal(result.hasDescription, true);
    assert.equal(result.marker, "[FORM_COMPLETE]");
  });

  it("returns incomplete when no images", () => {
    const result = checkFormCompleteness({
      Attachments: [],
      Description: "商品が破損していました",
    });
    assert.equal(result.isComplete, false);
    assert.equal(result.hasImages, false);
    assert.equal(result.hasDescription, true);
    assert.equal(result.marker, "[FORM_INCOMPLETE: no_image]");
  });

  it("returns incomplete when no description", () => {
    const result = checkFormCompleteness({
      Attachments: [{ url: "https://example.com/img.jpg" }],
      Description: "",
    });
    assert.equal(result.isComplete, false);
    assert.equal(result.hasImages, true);
    assert.equal(result.hasDescription, false);
    assert.equal(result.marker, "[FORM_INCOMPLETE: no_description]");
  });

  it("returns incomplete when both missing", () => {
    const result = checkFormCompleteness({
      Attachments: null,
      Description: "   ",
    });
    assert.equal(result.isComplete, false);
    assert.equal(result.hasImages, false);
    assert.equal(result.hasDescription, false);
    assert.equal(result.marker, "[FORM_INCOMPLETE: no_image,no_description]");
  });

  it("handles undefined fields gracefully", () => {
    const result = checkFormCompleteness({});
    assert.equal(result.isComplete, false);
    assert.equal(result.hasImages, false);
    assert.equal(result.hasDescription, false);
    assert.ok(result.marker.startsWith("[FORM_INCOMPLETE:"));
  });
});
