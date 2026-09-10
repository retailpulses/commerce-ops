import assert from "node:assert/strict";
import test from "node:test";
import { renderTicketPage } from "../src/services/htmlRenderer.js";
import type { TicketShareDTO } from "../src/types.js";

const dto: TicketShareDTO = {
  ticketNumber: "T-1<script>",
  platform: "mercari",
  shopName: "Shop",
  externalOrderId: "ORDER-1",
  status: "open",
  priority: "normal",
  issueTypes: ["wrong_item"],
  startedDate: "2026-07-16T00:00:00.000Z",
  products: [],
  sellerDescription: "Safe <b>description</b>",
  expiry: "2026-07-23T00:00:00.000Z",
  evidence: [
    { attachmentId: "11111111-1111-4111-8111-111111111111", fileName: "photo.jpg", mimeType: "image/jpeg", size: 10 },
    { attachmentId: "22222222-2222-4222-8222-222222222222", fileName: "video.mp4", mimeType: "video/mp4", size: 20 },
  ],
};

test("seller HTML escapes DTO values and renders same-origin image/video previews", () => {
  const html = renderTicketPage(dto, "a".repeat(64));
  assert.doesNotMatch(html, /T-1<script>/);
  assert.match(html, /T-1&lt;script&gt;/);
  assert.match(html, /Safe &lt;b&gt;description&lt;\/b&gt;/);
  assert.match(html, /class="evidence-thumbnail" loading="lazy"/);
  assert.match(html, /<video[^>]+controls preload="metadata">/);
  assert.match(html, /class="lightbox"/);
  assert.match(html, /JST/);
});
