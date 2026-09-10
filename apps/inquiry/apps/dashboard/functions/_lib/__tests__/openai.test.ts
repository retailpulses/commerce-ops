import { describe, expect, it } from "vitest";

import { COPYWRITE_DEFAULT_PROMPT, normalizeCopywrittenSalutation } from "../openai";

describe("inquiry copywriting salutation", () => {
  it("requires the neutral customer salutation in the default prompt", () => {
    expect(COPYWRITE_DEFAULT_PROMPT).toContain("Always address the customer as お客様");
    expect(COPYWRITE_DEFAULT_PROMPT).not.toContain("Use the customer's nickname in the greeting");
  });

  it.each([
    ["メルカリShops様\n\nお問い合わせありがとうございます。", "お客様\n\nお問い合わせありがとうございます。"],
    ["メルカリ Shops 様\n\nお問い合わせありがとうございます。", "お客様\n\nお問い合わせありがとうございます。"],
    ["メルカリショップ様\n\nお問い合わせありがとうございます。", "お客様\n\nお問い合わせありがとうございます。"],
  ])("replaces marketplace labels even when an active prompt emits them", (input, expected) => {
    expect(normalizeCopywrittenSalutation(input)).toBe(expected);
  });

  it("does not alter an already-correct customer salutation", () => {
    expect(normalizeCopywrittenSalutation("お客様\n\nありがとうございます。")).toBe(
      "お客様\n\nありがとうございます。",
    );
  });
});
