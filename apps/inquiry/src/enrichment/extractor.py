"""MercariExtractor — browser-based field extraction via Playwright.

Data layer: reads from and writes to Supabase (PostgREST) using the
canonical ``inquiries`` table schema.
"""

from __future__ import annotations

import os
import re
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright

from src.enrichment.config import EnrichmentConfig
from src.enrichment.error import EnrichmentError, ExtractionError
from src.runtime_log import RunLogger
from src.supabase_client import SupabaseClient


EXTRACTION_SCRIPT = Path(__file__).resolve().parent / "extract-inquiry-fields.js"

# Fields written to the inquiries table (extraction_key → supabase_column_name)
# These are the canonical Supabase column names from the migration SQL.
INQUIRY_FIELD_MAP: Dict[str, str] = {
    "customerName": "customer_nickname",
    "productId": "mercari_product_id",
    "variantName": "mercari_variant_name",
    "messageContent": "last_custom_message",
}

# Column used for product lookup in the product_variants table
PRODUCT_SKU_FIELD = "item_code"

# Only Mercari Shops seller inquiry URLs are valid for browser extraction
_MERCARI_INQUIRY_URL_RE = (
    r"^https://mercari-shops\.com/seller/shops/[^/\s]+"
    r"/(?:inquiries|talk-rooms)/"
)

# SIGTERM handling — graceful shutdown between rows
_shutdown_requested = False


def _sigterm_handler(signum: int, frame: Any) -> None:
    global _shutdown_requested
    _shutdown_requested = True


# Register SIGTERM handler at module level (safe to call multiple times)
signal.signal(signal.SIGTERM, _sigterm_handler)


class MercariExtractor:
    """Orchestrates Playwright-driven browser extraction of Mercari inquiry fields.

    Reads inquiry data from Supabase (via canonical inquiry ID or pending
    enrichment query) and writes extracted fields back to the canonical
    ``inquiries`` table columns.
    """

    def __init__(
        self,
        config: EnrichmentConfig,
        dry_run: bool = False,
        supabase_client: SupabaseClient | None = None,
    ) -> None:
        self.config = config
        self.dry_run = dry_run

        self.supabase = supabase_client or SupabaseClient(
            url=config.supabase_url,
            service_role_key=config.supabase_service_role_key,
            writes_enabled=config.inquiry_enrichment_writes_enabled and not dry_run,
        )
        self.logger = RunLogger(config.log_file)

        # Reset shutdown flag at init (new run)
        global _shutdown_requested
        _shutdown_requested = False

    # --- Public API ---

    def enrich_one(self, inquiry_id: int) -> Dict[str, Any]:
        """Enrich one inquiry by its canonical Supabase ID."""
        run_id = self.logger.start_run("enrich_inquiry", extra={"inquiry_id": inquiry_id})

        try:
            row = self.supabase.get_inquiry_by_id(inquiry_id)
        except Exception as e:
            self.logger.end_run(run_id, status="failed", error_summary=str(e))
            return {"ok": False, "error": str(e), "inquiry_id": inquiry_id}

        if row is None:
            msg = f"No inquiry found for id={inquiry_id}"
            self.logger.end_run(run_id, status="failed", error_summary=msg)
            return {"ok": False, "error": msg, "inquiry_id": inquiry_id}

        return self._enrich_row(row, run_id)

    def enrich_pending(self, limit: int = 5, since_hours: int | None = None) -> Dict[str, Any]:
        """Fetch and enrich inquiry rows missing enrichment fields.

        Fetches more rows than *limit* (overscan) to account for rows that
        are skipped because they lack a URL or are already enriched.  Stops
        after *limit* rows have actually been processed.

        If *since_hours* is set, only rows with ``inquiry_date`` within
        that many hours of now are considered.
        """
        run_id = self.logger.start_run("enrich_pending")
        counters: dict[str, int] = {
            "fetched": 0, "enriched": 0, "skipped": 0, "failed": 0,
        }
        errors: list[str] = []
        previews: list[dict[str, Any]] = []

        try:
            rows = self.supabase.list_inquiries_pending_enrichment(
                limit=limit, since_hours=since_hours,
            )
            counters["fetched"] = len(rows)

            processed = 0
            for row in rows:
                # Graceful shutdown check between rows
                if _shutdown_requested:
                    self.logger.log_event(
                        run_id, "shutdown", {"reason": "SIGTERM received"}
                    )
                    break

                if processed >= limit:
                    break

                inquiry_id = row.get("id")
                if not inquiry_id:
                    counters["skipped"] += 1
                    continue

                url = row.get("url")
                if not url:
                    counters["skipped"] += 1
                    continue

                if since_hours is not None:
                    if not self._within_hours(row, since_hours):
                        counters["skipped"] += 1
                        continue

                if self._already_enriched(row):
                    counters["skipped"] += 1
                    continue

                result = self._enrich_row(row, run_id)
                processed += 1  # count every attempt toward limit
                if result.get("ok"):
                    counters["enriched"] += 1
                    if self.dry_run:
                        previews.append(result)
                else:
                    counters["failed"] += 1
                    errors.append(result.get("error", f"inquiry_{inquiry_id}"))

        except Exception as e:
            self.logger.end_run(
                run_id, status="failed", error_summary=str(e), counters=counters
            )
            return {"ok": False, "error": str(e), "counters": counters}

        self.logger.end_run(run_id, status="completed", counters=counters)
        response: dict[str, Any] = {"ok": True, "counters": counters, "errors": errors}
        if self.dry_run and previews:
            response["previews"] = previews
        return response

    # --- Internal ---

    def _enrich_row(self, row: Dict[str, Any], run_id: str) -> Dict[str, Any]:
        inquiry_id = row.get("id")
        url = row.get("url", "")

        if not url:
            return {"ok": False, "error": "No URL", "inquiry_id": inquiry_id}

        # Guard: only Mercari Shops seller inquiry URLs are valid
        if not re.match(_MERCARI_INQUIRY_URL_RE, url):
            return {
                "ok": False,
                "error": f"Not a Mercari inquiry URL: {url[:80]}",
                "inquiry_id": inquiry_id,
            }

        shop_key = row.get("shop_key", "")
        chrome_profile = self._resolve_profile(shop_key)

        payload: dict[str, Any] = {}

        if self.dry_run:
            # Dry-run: skip browser extraction, show what would be attempted
            return {
                "ok": True,
                "inquiry_id": inquiry_id,
                "dry_run": True,
                "would_extract_from": url,
                "chrome_profile": chrome_profile,
                "shop_key": shop_key,
                "current_values": {
                    col: row.get(col, "") or None
                    for col in INQUIRY_FIELD_MAP.values()
                },
            }

        try:
            extracted = self._extract_via_playwright(
                inquiry_id, url, shop_key or "unknown", chrome_profile,
                row_hints={
                    "customer_name": row.get("customer_nickname", ""),
                    "message_text": row.get("inquiry_body", ""),
                },
            )
        except ExtractionError as e:
            return {"ok": False, "error": str(e), "inquiry_id": inquiry_id}

        if not extracted:
            return {"ok": False, "error": "Playwright returned no data", "inquiry_id": inquiry_id}

        payload = self._build_payload(extracted)

        # skuCode → product variant lookup → inquiry_product_links
        sku_code = extracted.get("skuCode")
        if sku_code:
            matched_product = self._lookup_product_variant(sku_code)
            if matched_product:
                # Write to inquiry_product_links junction table
                variant_name = matched_product.get("variant_name", "")
                product_name = _resolve_product_name(matched_product)
                try:
                    self.supabase.create_inquiry_product_link(
                        inquiry_id=inquiry_id,
                        product_variant_id=str(matched_product.get("id", "")),
                        item_code=sku_code.strip(),
                        product_name=product_name or variant_name,
                        is_primary=True,
                    )
                except Exception as e:
                    # Log but don't fail enrichment for link failure
                    self.logger.log_event(
                        run_id, "link_warning",
                        {"sku_code": sku_code, "error": str(e)[:200]},
                    )

        if not payload:
            return {
                "ok": False,
                "error": "No fields to write",
                "inquiry_id": inquiry_id,
                "raw_extraction": {
                    k: extracted.get(k) for k in INQUIRY_FIELD_MAP
                },
                "url_loaded": extracted.get("url"),
                "page_title": extracted.get("pageTitle"),
            }

        if not self.dry_run:
            try:
                self.supabase.update_inquiry(inquiry_id, payload)
            except Exception as e:
                return {"ok": False, "error": str(e)[:200], "inquiry_id": inquiry_id}

        result: dict[str, Any] = {
            "ok": True, "inquiry_id": inquiry_id,
            "fields_written": list(payload.keys()),
        }
        if self.dry_run:
            result["would_write"] = payload
        return result

    @staticmethod
    def _within_hours(row: Dict[str, Any], hours: int) -> bool:
        """Return True if the row's inquiry_date is within *hours* of now."""
        from datetime import datetime, timedelta, timezone

        raw = row.get("inquiry_date", "")
        if not raw:
            return False
        try:
            if isinstance(raw, str):
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            else:
                return False
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            return dt >= cutoff
        except (ValueError, TypeError):
            return False

    def _resolve_profile(self, shop_key: str) -> str:
        """Map Supabase shop_key value to a Chrome profile name.

        Tries exact match first, then falls back to the default profile.
        Config can be updated to use shop_key values (shop1, shop2, …).
        """
        if not shop_key:
            return self.config.enrichment_default_profile
        mapping = self.config.enrichment_shop_profiles
        return mapping.get(shop_key, self.config.enrichment_default_profile)

    def _already_enriched(self, row: Dict[str, Any]) -> bool:
        """Return True if all enrichment fields already have values."""
        for column in INQUIRY_FIELD_MAP.values():
            val = row.get(column)
            if not val:
                return False
        return True

    def _build_payload(self, extracted: Dict[str, Any]) -> Dict[str, Any]:
        """Map extraction keys to Supabase column names for the inquiries table."""
        payload: Dict[str, Any] = {}
        for extract_key, column_name in INQUIRY_FIELD_MAP.items():
            value = extracted.get(extract_key)
            if value:
                payload[column_name] = value
        return payload

    def _lookup_product_variant(self, sku_code: str) -> Dict[str, Any] | None:
        """Search the product_variants table for a matching SKU code."""
        try:
            return self.supabase.find_product_variant_by_item_code(sku_code)
        except Exception:
            pass
        return None

    def _extract_via_playwright(
        self, inquiry_id: int, url: str, shop_name: str, chrome_profile: str,
        row_hints: Dict[str, str] | None = None,
    ) -> Dict[str, Any] | None:
        """Launch Chrome with the shop's profile, navigate to the inquiry
        page, and evaluate the extraction JavaScript.

        Uses ``launch_persistent_context`` because Mercari stores auth state
        in IndexedDB / Service Workers — ``storage_state()`` cannot capture
        that.

        The *chrome_data_dir* is a **non-default** Chrome user-data directory
        (Chrome blocks remote debugging on the default location).  Profiles
        are created by the one-time auth setup script.

        If the URL contains a truncated inquiry ID (common in notification
        emails), this method auto-resolves the full ID by scraping the
        inquiries list page.

        If the URL is a legacy ``/talk-rooms/`` URL (a different ID scheme
        that Mercari no longer maps), this method resolves by navigating
        to the inquiries list page and matching on existing row data
        (customer name or message text).
        """
        js_script = EXTRACTION_SCRIPT.read_text()
        chrome_data_dir = self.config.enrichment_chrome_data_dir
        timeout_ms = self.config.enrichment_timeout * 1000

        profile_path = os.path.join(chrome_data_dir, chrome_profile)
        if not os.path.isdir(profile_path):
            raise ExtractionError(
                f"Chrome profile not found: {profile_path}. "
                f"Run scripts/setup_playwright_auth.py first."
            )

        try:
            with sync_playwright() as p:
                context = p.chromium.launch_persistent_context(
                    user_data_dir=chrome_data_dir,
                    headless=self.config.enrichment_headless,
                    channel="chrome",
                    args=[
                        f"--profile-directory={chrome_profile}",
                        "--no-first-run",
                        "--no-default-browser-check",
                    ],
                )

                page = context.new_page()
                try:
                    is_talk_room = "/talk-rooms/" in url

                    if is_talk_room:
                        # Legacy talk-room URLs: IDs don't map to /inquiries/.
                        # Resolve by matching row content on the list page.
                        resolved = self._resolve_talk_room_inquiry(
                            page, url, row_hints, timeout_ms,
                        )
                        if resolved:
                            page.goto(resolved,
                                      wait_until="domcontentloaded",
                                      timeout=timeout_ms)
                        else:
                            return None
                    else:
                        # --- Navigate to inquiry detail ---
                        page.goto(url, wait_until="domcontentloaded",
                                  timeout=timeout_ms)

                        # Detect sign-in redirect
                        if "signin" in page.url:
                            raise ExtractionError(
                                f"Not authenticated for inquiry {inquiry_id}. "
                                f"Log into Mercari as {shop_name} in "
                                f"profile '{chrome_profile}' first."
                            )

                        # Resolve truncated inquiry IDs by scraping
                        # the list page
                        if page.locator(
                            'text=ページが見つかりませんでした'
                        ).count() > 0:
                            resolved = self._resolve_full_inquiry_url(
                                page, url, timeout_ms,
                            )
                            if resolved:
                                page.goto(resolved,
                                          wait_until="domcontentloaded",
                                          timeout=timeout_ms)
                            else:
                                return None

                    # Wait for the inquiry content to render
                    try:
                        page.wait_for_selector(
                            'text=メッセージ', timeout=10000,
                        )
                    except PlaywrightTimeout:
                        pass  # extraction handles missing elements

                    extracted = page.evaluate(js_script)
                finally:
                    context.close()
        except PlaywrightTimeout as e:
            raise ExtractionError(
                f"Playwright timed out for inquiry {inquiry_id}: {e}"
            )
        except ExtractionError:
            raise
        except Exception as e:
            raise ExtractionError(
                f"Playwright extraction failed for inquiry {inquiry_id}: {e}"
            )

        if isinstance(extracted, dict):
            extracted.setdefault("inquiry_id", inquiry_id)
            return extracted
        return None

    # --- URL resolution ---

    @staticmethod
    def _resolve_full_inquiry_url(
        page, truncated_url: str, timeout_ms: int,
    ) -> str | None:
        """Scrape the inquiries list page to find the full inquiry ID.

        Mercari notification emails often contain truncated inquiry IDs
        (the first 8 characters).  The list page exposes full 24-character
        IDs in ``data-testid`` attributes on each row.
        """

        # Extract the short inquiry ID and shop ID from the truncated URL
        m = re.search(r'/shops/([^/]+)/inquiries/([^/\s?#]+)', truncated_url)
        if not m:
            return None
        shop_id, short_id = m.group(1), m.group(2)

        list_url = (
            f"https://mercari-shops.com/seller/shops/{shop_id}/inquiries"
        )
        page.goto(list_url, wait_until="domcontentloaded",
                  timeout=timeout_ms)
        page.wait_for_timeout(3000)  # let React render the table

        # Find the full inquiry ID that starts with the short prefix
        full_id = page.evaluate(
            """([shortId]) => {
                const tbody = document.querySelector('tbody');
                if (!tbody) return null;
                const rows = tbody.querySelectorAll('tr');
                for (const row of rows) {
                    for (const attr of row.querySelectorAll('[data-testid]')) {
                        const testId = attr.getAttribute('data-testid') || '';
                        const m = testId.match(
                            /^inquiry-(?:name|status|type)-(.+)$/
                        );
                        if (m && m[1].startsWith(shortId)) {
                            return m[1];
                        }
                    }
                }
                return null;
            }""",
            short_id,
        )

        if full_id and full_id != short_id:
            return (
                f"https://mercari-shops.com/seller/shops/{shop_id}"
                f"/inquiries/{full_id}"
            )
        return None

    @staticmethod
    def _resolve_talk_room_inquiry(
        page, url: str, row_hints: dict | None, timeout_ms: int,
    ) -> str | None:
        """Resolve a legacy ``/talk-rooms/`` URL to a current ``/inquiries/``
        detail page.

        Mercari migrated from ``/talk-rooms/`` to ``/inquiries/`` and
        changed the ID scheme entirely.  Old talk-room URLs redirect to the
        inquiries **list** page, not the detail page.  This method navigates
        to the list page and matches the target inquiry by customer name or
        message text from the row.
        """

        m = re.search(r'/shops/([^/]+)/talk-rooms/', url)
        if not m:
            return None
        shop_id = m.group(1)

        list_url = (
            f"https://mercari-shops.com/seller/shops/{shop_id}/inquiries"
        )
        page.goto(list_url, wait_until="domcontentloaded",
                  timeout=timeout_ms)
        page.wait_for_timeout(3000)  # let React render

        customer_name = (row_hints or {}).get("customer_name", "")
        message_text = (row_hints or {}).get("message_text", "")

        # Build search terms from row hints
        search_terms: list[str] = []
        if customer_name and customer_name.strip():
            search_terms.append(customer_name.strip())
        if message_text and message_text.strip():
            # Use first 15 chars of message as search term
            search_terms.append(message_text.strip()[:15])

        if not search_terms:
            return None  # nothing to match on

        # Search the list page for matching inquiry
        full_id = page.evaluate(
            """(opts) => {
                const searchTerms = opts.searchTerms;
                const tbody = document.querySelector('tbody');
                if (!tbody) return null;
                const rows = tbody.querySelectorAll('tr');
                for (const row of rows) {
                    const text = (row.textContent || '').trim();
                    if (searchTerms.every(
                        function(term) { return text.includes(term); }
                    )) {
                        for (const attr of row.querySelectorAll(
                            '[data-testid]'
                        )) {
                            const testId =
                                attr.getAttribute('data-testid') || '';
                            const m = testId.match(
                                /^inquiry-name-(.+)$/
                            );
                            if (m) return m[1];
                        }
                    }
                }
                return null;
            }""",
            {"searchTerms": search_terms},
        )

        if full_id:
            return (
                f"https://mercari-shops.com/seller/shops/{shop_id}"
                f"/inquiries/{full_id}"
            )
        return None


def _resolve_product_name(product_row: Dict[str, Any]) -> str:
    """Best-effort product name from a product_variants row.

    Tries ``variant_name`` first, then looks for a ``products.title``
    if the row was joined.
    """
    variant_name = (product_row.get("variant_name") or "").strip()
    if variant_name:
        return variant_name
    # Check for joined product name from parent query
    product_title = (product_row.get("products", {}).get("title") or "")
    if isinstance(product_title, str) and product_title.strip():
        return product_title.strip()
    return ""
