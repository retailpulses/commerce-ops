"""Supabase/PostgREST adapter for inquiry-automation VPS enrichment code.

Uses the installed supabase-py library to communicate with PostgREST.

Env guard:
  INQUIRY_ENRICHMENT_WRITES_ENABLED=1 — required for write operations.
  Without it, update/create methods raise RuntimeError.
"""

from __future__ import annotations

import random
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from supabase import create_client, Client

from src.errors import (
    SupabaseAuthError,
    SupabaseError,
    SupabaseNotFoundError,
)


# Exponential backoff with jitter
def _sleep_with_backoff(attempt: int, base_s: float = 1.0, max_s: float = 15.0) -> None:
    delay = min(base_s * (2 ** attempt), max_s)
    delay += random.uniform(0, delay * 0.25)  # ±25% jitter
    time.sleep(delay)


# --- Exceptions ---

def _raise_on_api_error(response: Any) -> None:
    """Inspect a supabase-py response for error indicators.

    supabase-py returns ``Response[list]`` objects where errors surface
    as non-None ``error`` attributes rather than HTTP-level exceptions.
    """
    from_postgrest_error = getattr(response, "error", None)
    if from_postgrest_error:
        code = getattr(from_postgrest_error, "code", "") or ""
        message = str(from_postgrest_error)
        if code in ("401", "403") or "JWT" in message or "Auth" in message:
            raise SupabaseAuthError(f"Supabase auth failure: {message}")
        if code == "404" or "not found" in message.lower():
            raise SupabaseNotFoundError(f"Supabase resource not found: {message}")
        raise SupabaseError(f"Supabase API error ({code}): {message}")


_MAX_RETRIES = 3
_TIMEOUT_S = 30


class SupabaseClient:
    """Supabase/PostgREST adapter for inquiry-automation enrichment.

    Wraps ``supabase-py`` with retry, timeout, and write-gating.
    """

    def __init__(
        self,
        url: str,
        service_role_key: str,
        writes_enabled: bool = False,
        client: Client | None = None,
    ) -> None:
        if not url or not service_role_key:
            raise SupabaseError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
            )
        self._client: Client = client or create_client(url, service_role_key)
        self.writes_enabled = writes_enabled

    # ------------------------------------------------------------------
    # Inquiry reads
    # ------------------------------------------------------------------

    def get_inquiry_by_id(self, inquiry_id: int) -> Dict[str, Any] | None:
        """Fetch a single inquiry by its canonical Supabase ``id``."""
        if inquiry_id is None:
            return None

        for attempt in range(_MAX_RETRIES):
            try:
                resp = (
                    self._client.table("inquiries")
                    .select("*")
                    .eq("id", inquiry_id)
                    .limit(1)
                    .execute()
                )
                _raise_on_api_error(resp)
                data = resp.data if hasattr(resp, "data") else []
                if data and len(data) > 0:
                    return data[0]
                return None
            except SupabaseError:
                raise
            except Exception as e:
                if attempt < _MAX_RETRIES - 1:
                    _sleep_with_backoff(attempt)
                    continue
                raise SupabaseError(
                    f"Failed to get inquiry by id={inquiry_id}: {e}"
                ) from e

        return None

    def list_inquiries_pending_enrichment(
        self, limit: int = 15, since_hours: int | None = None
    ) -> List[Dict[str, Any]]:
        """Return inquiries that need enrichment.

        Criteria:
        - ``url`` is not null
        - At least one enrichment field is missing (mercari_product_id,
          mercari_variant_name, last_custom_message)
        - ``deleted_at`` IS NULL (not soft-deleted)
        """
        overscan = min(limit * 3, 200)

        for attempt in range(_MAX_RETRIES):
            try:
                query = (
                    self._client.table("inquiries")
                    .select("*")
                    .not_.is_("url", "null")
                    .is_("deleted_at", "null")
                    .or_(
                        "mercari_product_id.is.null,"
                        "mercari_variant_name.is.null,"
                        "last_custom_message.is.null"
                    )
                    .order("inquiry_date", desc=True, nullsfirst=False)
                    .limit(overscan)
                )

                if since_hours is not None:
                    cutoff = (
                        datetime.now(timezone.utc) - timedelta(hours=since_hours)
                    ).isoformat()
                    query = query.gte("inquiry_date", cutoff)

                resp = query.execute()
                _raise_on_api_error(resp)
                return list(resp.data) if hasattr(resp, "data") else []
            except SupabaseError:
                raise
            except Exception as e:
                if attempt < _MAX_RETRIES - 1:
                    _sleep_with_backoff(attempt)
                    continue
                raise SupabaseError(
                    f"Failed to list inquiries pending enrichment: {e}"
                ) from e

        return []

    # ------------------------------------------------------------------
    # Inquiry writes
    # ------------------------------------------------------------------

    def update_inquiry(
        self, inquiry_id: int, payload: Dict[str, Any]
    ) -> Dict[str, Any] | None:
        """PATCH an inquiry row by its Supabase ``id``."""
        self._assert_writes_enabled()

        if not payload:
            return None

        for attempt in range(_MAX_RETRIES):
            try:
                resp = (
                    self._client.table("inquiries")
                    .update(payload)
                    .eq("id", inquiry_id)
                    .execute()
                )
                _raise_on_api_error(resp)
                data = resp.data if hasattr(resp, "data") else []
                if data and len(data) > 0:
                    return data[0]
                return None
            except SupabaseError:
                raise
            except Exception as e:
                if attempt < _MAX_RETRIES - 1:
                    _sleep_with_backoff(attempt)
                    continue
                raise SupabaseError(
                    f"Failed to update inquiry {inquiry_id}: {e}"
                ) from e

        return None

    # ------------------------------------------------------------------
    # Product variant lookup
    # ------------------------------------------------------------------

    def find_product_variant_by_item_code(
        self, item_code: str
    ) -> Dict[str, Any] | None:
        """Search the ``product_variants`` table by ``item_code``."""
        if not item_code or not item_code.strip():
            return None

        code = item_code.strip()

        for attempt in range(_MAX_RETRIES):
            try:
                resp = (
                    self._client.table("product_variants")
                    .select("*")
                    .eq("item_code", code)
                    .limit(3)
                    .execute()
                )
                _raise_on_api_error(resp)
                data = resp.data if hasattr(resp, "data") else []
                if data and len(data) > 0:
                    # Return exact match — item_code is unique
                    for row in data:
                        if str(row.get("item_code", "")).strip() == code:
                            return row
                    return data[0]
                return None
            except SupabaseError:
                raise
            except Exception as e:
                if attempt < _MAX_RETRIES - 1:
                    _sleep_with_backoff(attempt)
                    continue
                raise SupabaseError(
                    f"Failed to find product variant by item_code='{code}': {e}"
                ) from e

        return None

    # ------------------------------------------------------------------
    # Inquiry-product linking
    # ------------------------------------------------------------------

    def create_inquiry_product_link(
        self,
        inquiry_id: int,
        product_variant_id: str,
        item_code: str,
        product_name: str | None = None,
        is_primary: bool = False,
        confidence: float | None = None,
    ) -> Dict[str, Any] | None:
        """Create an idempotent link to a canonical product UUID.

        Existing links, including operator- or migration-owned links, are
        returned unchanged rather than having their provenance overwritten.
        """
        self._assert_writes_enabled()

        if not item_code or not product_variant_id:
            return None

        try:
            canonical_variant_id = str(uuid.UUID(product_variant_id))
        except (ValueError, AttributeError, TypeError) as exc:
            raise SupabaseError(
                f"Invalid product_variants UUID: {product_variant_id!r}"
            ) from exc

        existing_resp = (
            self._client.table("inquiry_product_links")
            .select("*")
            .eq("inquiry_id", inquiry_id)
            .eq("item_code_snapshot", item_code)
            .limit(1)
            .execute()
        )
        _raise_on_api_error(existing_resp)
        existing = existing_resp.data if hasattr(existing_resp, "data") else []
        if existing:
            return existing[0]

        primary_resp = (
            self._client.table("inquiry_product_links")
            .select("id")
            .eq("inquiry_id", inquiry_id)
            .eq("is_primary", True)
            .limit(1)
            .execute()
        )
        _raise_on_api_error(primary_resp)
        existing_primary = (
            primary_resp.data if hasattr(primary_resp, "data") else []
        )

        payload: Dict[str, Any] = {
            "inquiry_id": inquiry_id,
            "product_variant_id": canonical_variant_id,
            "item_code_snapshot": item_code,
            "product_name_snapshot": product_name or "",
            "is_primary": is_primary and not bool(existing_primary),
            "link_source": "enrichment",
        }
        if confidence is not None:
            payload["confidence"] = round(confidence, 2)

        for attempt in range(_MAX_RETRIES):
            try:
                resp = (
                    self._client.table("inquiry_product_links")
                    .insert(payload)
                    .execute()
                )
                _raise_on_api_error(resp)
                data = resp.data if hasattr(resp, "data") else []
                if data and len(data) > 0:
                    return data[0]
                return None
            except SupabaseError:
                raise
            except Exception as e:
                if attempt < _MAX_RETRIES - 1:
                    _sleep_with_backoff(attempt)
                    continue
                raise SupabaseError(
                    f"Failed to create inquiry_product_link for inquiry "
                    f"{inquiry_id}, item_code='{item_code}': {e}"
                ) from e

        return None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _assert_writes_enabled(self) -> None:
        if not self.writes_enabled:
            raise RuntimeError(
                "Supabase writes are disabled. "
                "Set INQUIRY_ENRICHMENT_WRITES_ENABLED=1 to enable."
            )
