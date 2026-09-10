import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { FIELD } from "../db-fields.mjs";
import {
  PORTAL_SERVER_SEARCH_FIELD_IDS,
  LIFECYCLE,
  REVIEW_FILTER,
  ATTENTION_FILTER,
  LIFECYCLE_ORDER_STATUS_MAP,
  REVIEW_FILTER_OPTION_MAP,
  applyPortalOrderSearch,
  buildPortalListCacheKey,
  buildServerSearchFilterSets,
  buildLifecycleFilters,
  buildReviewFilters,
  comparePortalRows,
  mergeRowsById,
  parseLifecycle,
  parseReviewFilter,
  parseAttentionFilter,
  translateLegacyParams,
  validatePortalParams,
  shouldPaginateBeforeEnrichment,
  isActivePipelineState,
  isTerminalPipelineState,
} from "../portal/shared.mjs";
import {
  buildServerFilters,
  buildPortalOrderSearchFilterSets,
  enrichPortalOrderRow,
  buildDegradedPortalRow,
  enrichUnreadStatus,
  listPortalSalesRows,
  platformSkuForRow,
  resolveRakutenRowsB2BItemCodes,
  filterPortalRowsByIssueType,
} from "../portal/order-list.mjs";
import { isValidReviewMutation } from "../order-state.mjs";

// ============================================================================
// Searchable field IDs
// ============================================================================

describe("PORTAL_SERVER_SEARCH_FIELD_IDS", () => {
  it("includes all four searchable fields", () => {
    assert.equal(PORTAL_SERVER_SEARCH_FIELD_IDS.length, 4);
    assert.ok(PORTAL_SERVER_SEARCH_FIELD_IDS.includes(FIELD.SALES.ORDER_ID));
    assert.ok(PORTAL_SERVER_SEARCH_FIELD_IDS.includes(FIELD.SALES.PRODUCT_NAME));
    assert.ok(PORTAL_SERVER_SEARCH_FIELD_IDS.includes(FIELD.SALES.ORIGINAL_PRODUCT_ID));
    assert.ok(PORTAL_SERVER_SEARCH_FIELD_IDS.includes(FIELD.SALES.B2B_ITEM_CODE));
  });
});

// ============================================================================
// Lifecycle filter constants
// ============================================================================

describe("LIFECYCLE", () => {
  it("has all expected values", () => {
    assert.equal(LIFECYCLE.ACTIVE, "active");
    assert.equal(LIFECYCLE.WAITING_FOR_PAYMENT, "waiting_for_payment");
    assert.equal(LIFECYCLE.WAITING_FOR_SHIPPING, "waiting_for_shipping");
    assert.equal(LIFECYCLE.COMPLETED, "completed");
    assert.equal(LIFECYCLE.CANCELED, "canceled");
    assert.equal(LIFECYCLE.ALL, "all");
  });
});

// ============================================================================
// Review filter constants
// ============================================================================

describe("REVIEW_FILTER", () => {
  it("has all expected values", () => {
    assert.equal(REVIEW_FILTER.ANY, "any");
    assert.equal(REVIEW_FILTER.PENDING_REVIEW, "pending_review");
    assert.equal(REVIEW_FILTER.AUTO_APPROVED, "auto_approved");
    assert.equal(REVIEW_FILTER.APPROVED, "approved");
    assert.equal(REVIEW_FILTER.ON_HOLD, "on_hold");
  });
});

// ============================================================================
// Attention filter constants
// ============================================================================

describe("ATTENTION_FILTER", () => {
  it("has all expected values", () => {
    assert.equal(ATTENTION_FILTER.ANY, "any");
    assert.equal(ATTENTION_FILTER.UNREAD, "unread");
    assert.equal(ATTENTION_FILTER.MESSAGE_CHECK_PENDING, "message_check_pending");
    assert.equal(ATTENTION_FILTER.LOW_MARGIN, "low_margin");
    assert.equal(ATTENTION_FILTER.PRICE_CONFIRMATION_NEEDED, "price_confirmation_needed");
    assert.equal(ATTENTION_FILTER.CRITICAL, "critical");
    assert.equal(ATTENTION_FILTER.WARNING, "warning");
    assert.equal(ATTENTION_FILTER.INFO, "info");
    assert.equal(ATTENTION_FILTER.NONE, "none");
  });
});

describe("filterPortalRowsByIssueType", () => {
  const rows = [
    { id: 1, risk_badges: [{ type: "low_margin", severity: "warning" }], has_unread: false, unread_classification: "read" },
    { id: 2, risk_badges: [{ type: "stock_unknown", severity: "warning" }], has_unread: false, unread_classification: "unknown" },
    { id: 3, risk_badges: [], has_unread: true, unread_classification: "unread" },
    { id: 4, risk_badges: [{ type: "cogs_unit_price_equal", severity: "warning" }], has_unread: false, unread_classification: "read" },
  ];

  it("filters Low Margin by badge type rather than all warnings", () => {
    assert.deepEqual(filterPortalRowsByIssueType(rows, ATTENTION_FILTER.LOW_MARGIN).map((row) => row.id), [1]);
  });

  it("filters orders needing supplier price confirmation by exact badge type", () => {
    assert.deepEqual(
      filterPortalRowsByIssueType(rows, ATTENTION_FILTER.PRICE_CONFIRMATION_NEEDED).map((row) => row.id),
      [4],
    );
  });

  it("temporarily exposes unknown message state as Message Check Pending", () => {
    assert.deepEqual(filterPortalRowsByIssueType(rows, ATTENTION_FILTER.MESSAGE_CHECK_PENDING).map((row) => row.id), [2]);
  });
});

// ============================================================================
// Query parsing and validation
// ============================================================================

describe("parseLifecycle", () => {
  it("defaults to active", () => {
    assert.equal(parseLifecycle(""), LIFECYCLE.ACTIVE);
    assert.equal(parseLifecycle(null), LIFECYCLE.ACTIVE);
    assert.equal(parseLifecycle(undefined), LIFECYCLE.ACTIVE);
  });

  it("parses valid lifecycle values", () => {
    assert.equal(parseLifecycle("active"), "active");
    assert.equal(parseLifecycle("waiting_for_payment"), "waiting_for_payment");
    assert.equal(parseLifecycle("waiting_for_shipping"), "waiting_for_shipping");
    assert.equal(parseLifecycle("completed"), "completed");
    assert.equal(parseLifecycle("canceled"), "canceled");
    assert.equal(parseLifecycle("all"), "all");
  });

  it("is case-insensitive", () => {
    assert.equal(parseLifecycle("Active"), "active");
    assert.equal(parseLifecycle("ALL"), "all");
  });

  it("throws on invalid lifecycle values", () => {
    assert.throws(() => parseLifecycle("unknown"), /invalid_lifecycle/);
    assert.throws(() => parseLifecycle("pending_review"), /invalid_lifecycle/);
  });
});

describe("parseReviewFilter", () => {
  it("defaults to any", () => {
    assert.equal(parseReviewFilter(""), REVIEW_FILTER.ANY);
    assert.equal(parseReviewFilter(null), REVIEW_FILTER.ANY);
  });

  it("parses valid review values", () => {
    assert.equal(parseReviewFilter("any"), "any");
    assert.equal(parseReviewFilter("pending_review"), "pending_review");
    assert.equal(parseReviewFilter("auto_approved"), "auto_approved");
    assert.equal(parseReviewFilter("approved"), "approved");
    assert.equal(parseReviewFilter("on_hold"), "on_hold");
  });

  it("throws on invalid review values", () => {
    assert.throws(() => parseReviewFilter("Pending Review"), /invalid_review/);
    assert.throws(() => parseReviewFilter("Active"), /invalid_review/);
    assert.throws(() => parseReviewFilter("unread"), /invalid_review/);
  });
});

describe("parseAttentionFilter", () => {
  it("defaults to any", () => {
    assert.equal(parseAttentionFilter(""), ATTENTION_FILTER.ANY);
  });

  it("throws on invalid attention values", () => {
    assert.throws(() => parseAttentionFilter("unknown"), /invalid_attention/);
  });
});

describe("validatePortalParams", () => {
  it("validates lifecycle, review, attention independently", () => {
    const params = new URLSearchParams("lifecycle=completed&review=approved&attention=unread&shop=Shop1");
    const parsed = validatePortalParams(params);
    assert.equal(parsed.lifecycle, "completed");
    assert.equal(parsed.review, "approved");
    assert.equal(parsed.attention, "unread");
    assert.equal(parsed.shop, "Shop1");
  });

  it("defaults lifecycle to active, review to any, attention to any", () => {
    const params = new URLSearchParams("");
    const parsed = validatePortalParams(params);
    assert.equal(parsed.lifecycle, LIFECYCLE.ACTIVE);
    assert.equal(parsed.review, REVIEW_FILTER.ANY);
    assert.equal(parsed.attention, ATTENTION_FILTER.ANY);
  });

  it("rejects invalid channel", () => {
    const params = new URLSearchParams("channel=amazon");
    assert.throws(() => validatePortalParams(params), /invalid_channel/);
  });

  it("rejects invalid lifecycle", () => {
    const params = new URLSearchParams("lifecycle=unknown");
    assert.throws(() => validatePortalParams(params), /invalid_lifecycle/);
  });

  it("rejects invalid review", () => {
    const params = new URLSearchParams("review=unknown");
    assert.throws(() => validatePortalParams(params), /invalid_review/);
  });

  it("rejects an unknown shop", () => {
    assert.throws(() => validatePortalParams(new URLSearchParams("shop=Shop9")), /invalid_shop/);
  });
});

// ============================================================================
// Legacy query translation
// ============================================================================

describe("translateLegacyParams", () => {
  it("translates legacy Active → lifecycle=active", () => {
    const params = new URLSearchParams("review_status=Active");
    translateLegacyParams(params);
    assert.equal(params.get("lifecycle"), "active");
    assert.equal(params.get("review"), "any");
  });

  it("translates legacy all → lifecycle=all", () => {
    const params = new URLSearchParams("review_status=all");
    translateLegacyParams(params);
    assert.equal(params.get("lifecycle"), "all");
  });

  it("translates legacy Unread → attention=unread", () => {
    const params = new URLSearchParams("review_status=Unread");
    translateLegacyParams(params);
    assert.equal(params.get("attention"), "unread");
  });

  it("translates legacy Pending Review → review=pending_review", () => {
    const params = new URLSearchParams("review_status=Pending Review");
    translateLegacyParams(params);
    assert.equal(params.get("review"), "pending_review");
  });

  it("does not override explicit new params", () => {
    const params = new URLSearchParams("review_status=Active&lifecycle=all");
    translateLegacyParams(params);
    assert.equal(params.get("lifecycle"), "all");
  });
});

// ============================================================================
// buildLifecycleFilters
// ============================================================================

describe("buildLifecycleFilters", () => {
  it("Active returns two filter sets (WFP + WFS)", () => {
    const filters = buildLifecycleFilters(LIFECYCLE.ACTIVE);
    const key = `filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`;
    assert.equal(filters.length, 2);
    assert.ok(filters[0][key]);
    assert.ok(filters[1][key]);
    assert.notEqual(filters[0][key], filters[1][key]);
    assert.equal(filters[0][`filter__field_${FIELD.SALES.ORDER_ID}__single_select_equal`], undefined);
  });

  it("All returns a single empty filter set", () => {
    const filters = buildLifecycleFilters(LIFECYCLE.ALL);
    assert.equal(filters.length, 1);
    assert.deepEqual(filters[0], {});
  });

  it("Completed returns a single status filter", () => {
    const filters = buildLifecycleFilters(LIFECYCLE.COMPLETED);
    assert.equal(filters.length, 1);
    assert.ok(filters[0][`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`]);
  });

  it("Canceled returns a single status filter", () => {
    const filters = buildLifecycleFilters(LIFECYCLE.CANCELED);
    assert.equal(filters.length, 1);
  });
});

// ============================================================================
// buildReviewFilters
// ============================================================================

describe("buildReviewFilters", () => {
  it("any returns empty object", () => {
    assert.deepEqual(buildReviewFilters(REVIEW_FILTER.ANY), {});
  });

  it("pending_review returns review_status equal filter", () => {
    const filters = buildReviewFilters(REVIEW_FILTER.PENDING_REVIEW);
    assert.ok(Object.keys(filters).length > 0);
  });

  it("auto_approved returns review_status equal filter", () => {
    const filters = buildReviewFilters(REVIEW_FILTER.AUTO_APPROVED);
    assert.ok(Object.keys(filters).length > 0);
  });
});

// ============================================================================
// buildServerSearchFilterSets
// ============================================================================

describe("buildServerSearchFilterSets", () => {
  it("returns base filters unchanged when no search query", () => {
    const result = buildServerSearchFilterSets({ shop: "Shop1" }, "", ["111", "222"]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { shop: "Shop1" });
  });

  it("creates one filter set per searchable field", () => {
    const result = buildServerSearchFilterSets({}, "test-query", ["111", "222"]);
    assert.equal(result.length, 2);
    assert.ok(result[0]["filter__field_111__contains"]);
    assert.ok(result[1]["filter__field_222__contains"]);
  });
});

// ============================================================================
// mergeRowsById
// ============================================================================

describe("mergeRowsById", () => {
  it("merges unique rows from multiple arrays", () => {
    const result = mergeRowsById([
      [{ id: 1, name: "a" }, { id: 2, name: "b" }],
      [{ id: 2, name: "b" }, { id: 3, name: "c" }],
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((r) => r.id).sort(), [1, 2, 3]);
  });
});

// ============================================================================
// buildPortalOrderSearchFilterSets (order-list)
// ============================================================================

describe("buildPortalOrderSearchFilterSets", () => {
  it("includes all four searchable fields", () => {
    const base = { shop: "Shop1" };
    const filters = buildPortalOrderSearchFilterSets(base, "2JSz");
    assert.equal(filters.length, 4);
    assert.ok(filters[0][`filter__field_${FIELD.SALES.ORDER_ID}__contains`]);
    assert.ok(filters[1][`filter__field_${FIELD.SALES.PRODUCT_NAME}__contains`]);
    assert.ok(filters[2][`filter__field_${FIELD.SALES.B2B_ITEM_CODE}__contains`]);
    assert.ok(filters[3][`filter__field_${FIELD.SALES.ORIGINAL_PRODUCT_ID}__contains`]);
  });
});

// ============================================================================
// listPortalSalesRows (multi-query merge)
// ============================================================================

describe("listPortalSalesRows", () => {
  it("merges server-side search results across lifecycle branches and search fields", async () => {
    const calls = [];
    const baserow = { salesOrderTableId: 903318 };
    const baseFilterList = [
      { lifecycle: "active_1" },
      { lifecycle: "active_2" },
    ];
    const rows = await listPortalSalesRows(
      baserow,
      baseFilterList,
      "chair",
      100,
      async (_client, _tableId, filters, _maxRows) => {
        calls.push({ filters });
        // Simulate different rows returned per query
        return [{ id: calls.length }];
      },
    );

    // 2 lifecycle branches × 4 search fields = 8 queries
    assert.equal(calls.length, 8);
    // Merge should return unique rows (8 queries × 1 unique row = 8 rows)
    assert.equal(rows.length, 8);
  });

  it("returns empty for empty base filter list", async () => {
    const baserow = { salesOrderTableId: 903318 };
    const rows = await listPortalSalesRows(baserow, [], "", 100);
    assert.equal(rows.length, 0);
  });
});

// ============================================================================
// applyPortalOrderSearch (local post-filter)
// ============================================================================

describe("applyPortalOrderSearch", () => {
  it("filters by order_id", () => {
    const rows = [
      { order_id: "order-1", product_name: "Desk", B2BItemCode: "SKU-1", original_product_id: "abc" },
      { order_id: "order-2", product_name: "Chair", B2BItemCode: "SKU-2", original_product_id: "def" },
    ];
    assert.equal(applyPortalOrderSearch(rows, "order-1").length, 1);
  });

  it("filters by product_name", () => {
    const rows = [
      { order_id: "order-1", product_name: "Desk", B2BItemCode: "SKU-1", original_product_id: "abc" },
      { order_id: "order-2", product_name: "Chair", B2BItemCode: "SKU-2", original_product_id: "def" },
    ];
    assert.equal(applyPortalOrderSearch(rows, "chair").length, 1);
    assert.equal(applyPortalOrderSearch(rows, "chair")[0].order_id, "order-2");
  });

  it("filters by B2BItemCode (critical for N511P425557W scenario)", () => {
    const rows = [
      { order_id: "order-1", product_name: "Product A", B2BItemCode: "N511P425557W", original_product_id: "abc" },
      { order_id: "order-2", product_name: "Product B", B2BItemCode: "SKU-2", original_product_id: "def" },
    ];
    const filtered = applyPortalOrderSearch(rows, "N511P425557W");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].order_id, "order-1");
  });

  it("filters by original_product_id", () => {
    const rows = [
      { order_id: "order-1", product_name: "Desk", B2BItemCode: "SKU-1", original_product_id: "ABC-123" },
      { order_id: "order-2", product_name: "Chair", B2BItemCode: "SKU-2", original_product_id: "DEF-456" },
    ];
    const filtered = applyPortalOrderSearch(rows, "ABC-123");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].order_id, "order-1");
  });

  it("returns all rows when search is empty", () => {
    const rows = [
      { order_id: "order-1", product_name: "Desk", B2BItemCode: "SKU-1", original_product_id: "abc" },
      { order_id: "order-2", product_name: "Chair", B2BItemCode: "SKU-2", original_product_id: "def" },
    ];
    assert.equal(applyPortalOrderSearch(rows, "").length, 2);
    assert.equal(applyPortalOrderSearch(rows, null).length, 2);
  });

  it("deduplicates matches across multiple search fields", () => {
    const rows = [
      { order_id: "order-1", product_name: "chair", B2BItemCode: "CHAIR-1", original_product_id: "chair-abc" },
      { order_id: "order-2", product_name: "desk", B2BItemCode: "DESK-1", original_product_id: "desk-def" },
    ];
    // "chair" matches order_id "order-1", product_name "chair", B2BItemCode "CHAIR-1", original_product_id "chair-abc"
    // But it's the same row — should return only once
    const filtered = applyPortalOrderSearch(rows, "chair");
    assert.equal(filtered.length, 1);
  });
});

// ============================================================================
// buildPortalListCacheKey
// ============================================================================

describe("buildPortalListCacheKey", () => {
  it("is stable across query param order", () => {
    const a = new URLSearchParams("shop=Shop1&lifecycle=active&review=approved&limit=50");
    const b = new URLSearchParams("limit=50&review=approved&lifecycle=active&shop=Shop1");
    assert.equal(buildPortalListCacheKey("orders", a), buildPortalListCacheKey("orders", b));
  });

  it("distinguishes different combinations", () => {
    const a = new URLSearchParams("lifecycle=active&review=on_hold");
    const b = new URLSearchParams("lifecycle=active&review=any");
    assert.notEqual(buildPortalListCacheKey("orders", a), buildPortalListCacheKey("orders", b));
  });
});

// ============================================================================
// shouldPaginateBeforeEnrichment
// ============================================================================

describe("shouldPaginateBeforeEnrichment", () => {
  it("keeps simple queue sorts on the cheaper path", () => {
    assert.equal(shouldPaginateBeforeEnrichment({ riskFilter: "", unreadFilter: "", sort: "purchase_date" }), true);
    assert.equal(shouldPaginateBeforeEnrichment({ riskFilter: "warning", unreadFilter: "", sort: "purchase_date" }), false);
    assert.equal(shouldPaginateBeforeEnrichment({ riskFilter: "", unreadFilter: "", sort: "margin" }), false);
    assert.equal(shouldPaginateBeforeEnrichment({ riskFilter: "", unreadFilter: "1", sort: "purchase_date" }), false);
  });
});

// ============================================================================
// comparePortalRows
// ============================================================================

describe("comparePortalRows", () => {
  it("sorts quantity numerically", () => {
    const a = { quantity: 2 };
    const b = { quantity: 10 };
    assert.ok(comparePortalRows(a, b, "quantity", "asc") < 0);
    assert.ok(comparePortalRows(a, b, "quantity", "desc") > 0);
  });
});

// ============================================================================
// enrichUnreadStatus
// ============================================================================

describe("enrichUnreadStatus", () => {
  it("never fabricates unread when order identity is incomplete", async () => {
    const unread = await enrichUnreadStatus({ PORTAL_KV: {} }, [
      { order_id: "test-order", shop_id: "", has_buyer_messages: false },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, false);
    assert.equal(info.classification, "unknown");
  });

  it("reads durable state key and classifies based on row fields + kv", async () => {
    const reads = [];
    const env = {
      PORTAL_KV: {
        async get(key) {
          reads.push(key);
          if (key === "message-state:v1:WMyisFmhbGWyVAPEwsfirn:test-order") {
            return {
              last_read_at: "2026-06-22T09:00:00.000Z",
              last_checked_at: new Date().toISOString(),
              last_check_status: "ok",
            };
          }
          return null;
        },
      },
    };

    const unread = await enrichUnreadStatus(env, [
      {
        order_id: "test-order",
        shop_id: "WMyisFmhbGWyVAPEwsfirn",
        has_buyer_messages: true,
        latest_buyer_message_id: "m5",
        latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
      },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, true);
    assert.equal(info.classification, "unread");
    assert.ok(info.last_checked_at);
    assert.equal(info.last_check_status, "ok");
    assert.equal(info.last_check_error, null);
    assert.deepEqual(reads, ["message-state:v1:WMyisFmhbGWyVAPEwsfirn:test-order"]);
  });

  it("returns read when buyer messages exist and last_read_at covers latest", async () => {
    const reads = [];
    const env = {
      PORTAL_KV: {
        async get(key) {
          reads.push(key);
          return {
            last_read_at: "2026-06-22T11:00:00.000Z",
            last_checked_at: new Date().toISOString(),
            last_check_status: "ok",
          };
        },
      },
    };

    const unread = await enrichUnreadStatus(env, [
      {
        order_id: "test-order",
        shop_id: "WMyisFmhbGWyVAPEwsfirn",
        has_buyer_messages: true,
        latest_buyer_message_id: "m3",
        latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
      },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, false);
    assert.equal(info.classification, "read");
    assert.deepEqual(reads, ["message-state:v1:WMyisFmhbGWyVAPEwsfirn:test-order"]);
  });

  it("keeps a confirmed buyer message unread when the health check failed", async () => {
    const env = {
      PORTAL_KV: {
        async get() {
          return {
            last_check_status: "failed",
            last_checked_at: new Date().toISOString(),
            last_check_error: "mercari_graphql_error",
          };
        },
      },
    };

    const unread = await enrichUnreadStatus(env, [
      {
        order_id: "test-order",
        shop_id: "WMyisFmhbGWyVAPEwsfirn",
        has_buyer_messages: true,
        latest_buyer_message_id: "m5",
        latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
        message_last_synced_at: "2026-06-22T10:00:00.000Z",
      },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, true);
    assert.equal(info.classification, "unread");
    assert.equal(info.last_check_status, "failed");
    assert.equal(info.last_check_error, "mercari_graphql_error");
  });

  it("classifies a confirmed buyer message as unread when read-state is missing", async () => {
    const env = {
      PORTAL_KV: {
        async get() {
          return null;
        },
      },
    };

    const unread = await enrichUnreadStatus(env, [
      {
        order_id: "test-order",
        shop_id: "WMyisFmhbGWyVAPEwsfirn",
        has_buyer_messages: true,
        latest_buyer_message_id: "m5",
        latest_buyer_message_at: "2026-06-22T10:00:00.000Z",
      },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, true);
    assert.equal(info.classification, "unread");
  });

  it("returns unknown but not unread when an order has never been checked", async () => {
    const env = {
      PORTAL_KV: {
        async get() {
          return null;
        },
      },
    };

    const unread = await enrichUnreadStatus(env, [
      {
        order_id: "test-order",
        shop_id: "WMyisFmhbGWyVAPEwsfirn",
        has_buyer_messages: false,
        latest_buyer_message_id: "",
        latest_buyer_message_at: "",
      },
    ]);

    const info = unread.get("test-order");
    assert.equal(info.has_unread, false);
    assert.equal(info.classification, "unknown");
  });
});

// ============================================================================
// Independent composition tests
// ============================================================================

describe("filter composition", () => {
  it("lifecycle and review compose independently", () => {
    // Active + On Hold should return operator-held active orders
    const lifecycleFilters = buildLifecycleFilters(LIFECYCLE.ACTIVE);
    const reviewFilters = buildReviewFilters(REVIEW_FILTER.ON_HOLD);
    assert.equal(lifecycleFilters.length, 2); // WFP + WFS

    // Each lifecycle branch should have the review filter
    for (const lf of lifecycleFilters) {
      const combined = { ...lf, ...reviewFilters };
      assert.ok(Object.keys(combined).length >= 2); // lifecycle filter + review filter
    }
  });

  it("All + Approved includes active and historical Approved rows", () => {
    const lifecycleFilters = buildLifecycleFilters(LIFECYCLE.ALL);
    assert.equal(lifecycleFilters.length, 1);
    assert.deepEqual(lifecycleFilters[0], {});

    const reviewFilters = buildReviewFilters(REVIEW_FILTER.APPROVED);
    assert.ok(Object.keys(reviewFilters).length > 0);

    const combined = { ...lifecycleFilters[0], ...reviewFilters };
    // No lifecycle restriction, only review filter
    assert.ok(combined[`filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`]);
  });

  it("Completed/Canceled + Pending Review returns no normalized terminal rows", async () => {
    const orderStatusKey = `filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`;
    const reviewStatusKey = `filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`;
    const terminalRows = [
      { id: "completed", orderStatusOption: LIFECYCLE_ORDER_STATUS_MAP[LIFECYCLE.COMPLETED][orderStatusKey], reviewStatusOption: null },
      { id: "canceled", orderStatusOption: LIFECYCLE_ORDER_STATUS_MAP[LIFECYCLE.CANCELED][orderStatusKey], reviewStatusOption: null },
    ];
    const listFixtureRows = async (_client, _tableId, filters) => terminalRows.filter((row) => (
      row.orderStatusOption === filters[orderStatusKey]
      && row.reviewStatusOption === filters[reviewStatusKey]
    ));

    for (const lifecycle of [LIFECYCLE.COMPLETED, LIFECYCLE.CANCELED]) {
      const filters = buildServerFilters({
        lifecycle,
        review: REVIEW_FILTER.PENDING_REVIEW,
        shop: "",
      });
      const rows = await listPortalSalesRows(
        { salesOrderTableId: "sales_orders" },
        filters,
        "",
        100,
        listFixtureRows,
      );
      assert.deepEqual(rows, []);
    }
  });

  it("Active + Pending Review composition remains unchanged", async () => {
    const orderStatusKey = `filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`;
    const reviewStatusKey = `filter__field_${FIELD.SALES.REVIEW_STATUS}__single_select_equal`;
    const activePendingRows = [
      {
        id: "waiting-for-shipping",
        orderStatusOption: LIFECYCLE_ORDER_STATUS_MAP[LIFECYCLE.WAITING_FOR_SHIPPING][orderStatusKey],
        reviewStatusOption: REVIEW_FILTER_OPTION_MAP[REVIEW_FILTER.PENDING_REVIEW][reviewStatusKey],
      },
    ];
    const listFixtureRows = async (_client, _tableId, filters) => activePendingRows.filter((row) => (
      row.orderStatusOption === filters[orderStatusKey]
      && row.reviewStatusOption === filters[reviewStatusKey]
    ));
    const filters = buildServerFilters({
      lifecycle: LIFECYCLE.ACTIVE,
      review: REVIEW_FILTER.PENDING_REVIEW,
      shop: "",
      channel: "mercari",
    });

    const rows = await listPortalSalesRows(
      { salesOrderTableId: "sales_orders" },
      filters,
      "",
      100,
      listFixtureRows,
    );

    assert.equal(filters.length, 2);
    assert.deepEqual(rows, activePendingRows);
  });
});

// ============================================================================
// Pipeline state: Active excludes terminal and unknown
// ============================================================================

describe("Active pipeline state filtering", () => {
  it("PAYMENT_PENDING is active", () => assert.equal(isActivePipelineState("PAYMENT_PENDING"), true));
  it("AWAITING_REVIEW is active", () => assert.equal(isActivePipelineState("AWAITING_REVIEW"), true));
  it("READY_TO_SHIP is active", () => assert.equal(isActivePipelineState("READY_TO_SHIP"), true));
  it("OPERATOR_HOLD is active", () => assert.equal(isActivePipelineState("OPERATOR_HOLD"), true));
  it("COMPLETED is not active", () => assert.equal(isActivePipelineState("COMPLETED"), false));
  it("CANCELLED is not active", () => assert.equal(isActivePipelineState("CANCELLED"), false));
  it("UNKNOWN is not active", () => assert.equal(isActivePipelineState("UNKNOWN"), false));
});

// ============================================================================
// Transition policy consistency
// ============================================================================

describe("isValidReviewMutation", () => {
  it("Pending Review → Approved is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "Approved");
    assert.equal(result.valid, true);
  });

  it("Pending Review → On Hold is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "On Hold");
    assert.equal(result.valid, true);
  });

  it("Auto-Approved → On Hold is valid (fixes the contradiction)", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Auto-Approved", "On Hold");
    assert.equal(result.valid, true);
  });

  it("Approved → On Hold is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Approved", "On Hold");
    assert.equal(result.valid, true);
  });

  it("On Hold → Approved is valid", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "On Hold", "Approved");
    assert.equal(result.valid, true);
  });

  it("terminal lifecycle (COMPLETED) rejects mutation", () => {
    const result = isValidReviewMutation("COMPLETED", "On Hold", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("terminal"));
  });

  it("terminal lifecycle (CANCELED) rejects mutation", () => {
    const result = isValidReviewMutation("CANCELED", "Pending Review", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("terminal"));
  });

  it("unknown target rejects", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Pending Review", "Unknown");
    assert.equal(result.valid, false);
  });

  it("same target rejects", () => {
    const result = isValidReviewMutation("WAITING_FOR_SHIPPING", "Approved", "Approved");
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("already_in_target"));
  });

  it("Waiting for Payment lifecycle allows review mutation", () => {
    const result = isValidReviewMutation("WAITING_FOR_PAYMENT", "Pending Review", "Approved");
    assert.equal(result.valid, true);
  });
});

// ── enrichPortalOrderRow platform_sku ──────────────────────────────────

describe("enrichPortalOrderRow platform_sku", () => {
  const productFields = {
    itemCodeFieldId: 1,
    effectiveTcogsFieldId: 2,
    ownedQtyFieldId: 3,
    qtyAvailableFieldId: 4,
    restockInfoFieldId: 5,
  };
  const commissionRate = 0.10;

  it("emits platform_sku from manage_number for Rakuten orders", () => {
    const row = {
      order_id: "440058-20260714-0379940609",
      product_name: "Test Product",
      B2BItemCode: "",
      original_product_id: "",
      manage_number: "sofabd-n511p407695",
      quantity: 1,
      product_price: 5000,
      shipping_price: 800,
      order_status: { value: "WAITING_FOR_SHIPPING" },
      shop_id: "Rakuten",
      review_status: { value: "Pending Review" },
      purchase_date: "2026-07-14",
      buyer_name: "",
      has_buyer_messages: false,
    };
    const productCache = new Map();
    const feeKeys = new Set();
    const result = enrichPortalOrderRow(row, productCache, productFields, commissionRate, feeKeys);
    assert.equal(result.platform_sku, "sofabd-n511p407695");
    assert.equal(result.original_product_id, "");
    assert.equal(result.B2BItemCode, "");
  });

  it("emits platform_sku from original_product_id for Mercari orders", () => {
    const row = {
      order_id: "mercari-order-1",
      product_name: "Test Product",
      B2BItemCode: "N511P407695W",
      original_product_id: "N511P407695W",
      manage_number: "",
      quantity: 1,
      product_price: 5000,
      shipping_price: 800,
      order_status: { value: "WAITING_FOR_SHIPPING" },
      shop_id: "Shop1",
      review_status: { value: "Pending Review" },
      purchase_date: "2026-07-14",
      buyer_name: "",
      has_buyer_messages: false,
    };
    const productCache = new Map();
    const feeKeys = new Set();
    const result = enrichPortalOrderRow(row, productCache, productFields, commissionRate, feeKeys);
    assert.equal(result.platform_sku, "N511P407695W");
    assert.equal(result.original_product_id, "N511P407695W");
  });

  it("emits platform_sku in degraded row", () => {
    const row = {
      order_id: "order-1",
      product_name: "Test",
      B2BItemCode: "",
      original_product_id: "",
      manage_number: "manage-123",
      quantity: 1,
      product_price: 1000,
      order_status: { value: "WAITING_FOR_SHIPPING" },
      shop_id: "Rakuten",
      review_status: { value: "Pending Review" },
      purchase_date: "2026-07-14",
      buyer_name: "",
    };
    const result = buildDegradedPortalRow(row);
    assert.equal(result.platform_sku, "manage-123");
  });

  it("does not let a stray manage_number replace a Mercari SKU", () => {
    assert.equal(platformSkuForRow({
      sales_channel: "mercari",
      shop_id: "Shop1",
      original_product_id: "MERCARI-SKU",
      manage_number: "rakuten-manage-number",
    }), "MERCARI-SKU");
  });

  it("batch-enriches duplicate Rakuten SKUs through one query pair", async () => {
    const rows = [
      { shop_id: "Rakuten", manage_number: "manage-1", B2BItemCode: "" },
      { shop_id: "Rakuten", manage_number: "manage-1", B2BItemCode: "" },
    ];
    const calls = [];
    const dataByTable = {
      platform_listings: [{ id: "listing-1", manage_number: "manage-1" }],
      product_platform_links: [{
        id: "link-1",
        listing_id: "listing-1",
        product_variants: { item_code: "ITEM-1" },
      }],
    };
    const supabase = {
      from(table) {
        calls.push(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          range: () => chain,
          then: (resolve) => resolve({ data: dataByTable[table], error: null }),
        };
        return chain;
      },
    };

    assert.deepEqual(await resolveRakutenRowsB2BItemCodes(rows, supabase), ["ITEM-1"]);
    assert.deepEqual(rows.map((row) => row.B2BItemCode), ["ITEM-1", "ITEM-1"]);
    assert.deepEqual(calls, ["platform_listings", "product_platform_links"]);
  });
});

describe("buildServerFilters channel isolation", () => {
  it("adds sales_channel='mercari' filter when channel is mercari", () => {
    const filterSets = buildServerFilters({ lifecycle: "active", channel: "mercari" });
    assert.ok(filterSets.length > 0, "produces at least one filter set");
    for (const filters of filterSets) {
      const mercariFilter = filters[`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`];
      assert.equal(mercariFilter, "mercari", "Mercari channel filter present");
    }
  });

  it("adds sales_channel='rakuten' filter when channel is rakuten", () => {
    const filterSets = buildServerFilters({ lifecycle: "active", channel: "rakuten" });
    assert.ok(filterSets.length > 0, "produces at least one filter set");
    for (const filters of filterSets) {
      const rakutenFilter = filters[`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`];
      assert.equal(rakutenFilter, "rakuten", "Rakuten channel filter present");
    }
  });

  it("different channels produce different sales_channel filters", () => {
    const mercariSets = buildServerFilters({ lifecycle: "all", channel: "mercari" });
    const rakutenSets = buildServerFilters({ lifecycle: "all", channel: "rakuten" });
    assert.equal(mercariSets.length, 1);
    assert.equal(rakutenSets.length, 1);
    const mercariChannel = mercariSets[0][`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`];
    const rakutenChannel = rakutenSets[0][`filter__field_${FIELD.SALES.SALES_CHANNEL}__equal`];
    assert.equal(mercariChannel, "mercari");
    assert.equal(rakutenChannel, "rakuten");
    assert.notEqual(mercariChannel, rakutenChannel, "channels are isolated");
  });
});

describe("buildLifecycleFilters Rakuten", () => {
  it("returns COMPLETED filter for Rakuten completed lifecycle", () => {
    const filterSets = buildLifecycleFilters("completed", "rakuten");
    assert.equal(filterSets.length, 1, "single filter set");
    const completedField = filterSets[0][`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`];
    assert.ok(completedField !== undefined, "COMPLETED filter is set");
  });

  it("returns empty array for Rakuten waiting_for_payment (not unsupported-unfiltered)", () => {
    const filterSets = buildLifecycleFilters("waiting_for_payment", "rakuten");
    assert.equal(filterSets.length, 0, "empty — no results for unsupported lifecycle");
  });

  it("returns empty array for Rakuten waiting_for_shipping (not unsupported-unfiltered)", () => {
    const filterSets = buildLifecycleFilters("waiting_for_shipping", "rakuten");
    assert.equal(filterSets.length, 0, "empty — no results for unsupported lifecycle");
  });

  it("returns CANCELED filter for Rakuten canceled lifecycle", () => {
    const filterSets = buildLifecycleFilters("canceled", "rakuten");
    assert.equal(filterSets.length, 1, "single filter set");
    const canceledField = filterSets[0][`filter__field_${FIELD.SALES.ORDER_STATUS}__single_select_equal`];
    assert.ok(canceledField !== undefined, "CANCELED filter is set");
  });

  it("returns active statuses for Rakuten active lifecycle", () => {
    const filterSets = buildLifecycleFilters("active", "rakuten");
    assert.equal(filterSets.length, 3, "three filter branches (PENDING_CONFIRMATION, CONFIRMED, RMS_CONFIRMED)");
  });
});
