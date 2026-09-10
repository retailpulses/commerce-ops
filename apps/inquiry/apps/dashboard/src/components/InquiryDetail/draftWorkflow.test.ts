import { describe, expect, it } from "vitest";
import { buildSendPayload, captureReviewMessage } from "./draftWorkflow";

describe("draft review workflow", () => {
  it("captures the exact trimmed Japanese draft for review and send", () => {
    const reviewMessage = captureReviewMessage("  ご確認ください。\nよろしくお願いします。  ");
    expect(reviewMessage).toBe("ご確認ください。\nよろしくお願いします。");
    expect(buildSendPayload(reviewMessage!, "")).toEqual({
      body: reviewMessage,
      followUpDueDate: null,
    });
  });

  it("keeps an explicit follow-up override in the outbound payload", () => {
    expect(buildSendPayload("日本語原文", "2026-09-07")).toEqual({
      body: "日本語原文",
      followUpDueDate: "2026-09-07",
    });
  });
});
