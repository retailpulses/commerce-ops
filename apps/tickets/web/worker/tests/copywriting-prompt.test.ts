import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COPYWRITE_PROMPT_VERSION,
  DEFAULT_SYSTEM_PROMPT,
} from "../src/clients/openai_copywrite";

describe("copywriting prompt resolution fidelity", () => {
  it("does not suppress operator-approved refund or compensation amounts", () => {
    assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /返金額を明示しない/);
    assert.match(DEFAULT_SYSTEM_PROMPT, /具体的な金額は、対応方針に記載されている場合、そのまま明示/);
  });

  it("requires every resolution term to be preserved", () => {
    assert.match(DEFAULT_SYSTEM_PROMPT, /金額、補償方法、期限、条件、次のアクションを省略・曖昧化・変更しない/);
    assert.match(DEFAULT_SYSTEM_PROMPT, /単なるお詫びや確認中の案内だけに置き換えない/);
  });

  it("uses a traceable prompt version", () => {
    assert.equal(COPYWRITE_PROMPT_VERSION, "resolution-fidelity-v1");
  });
});
