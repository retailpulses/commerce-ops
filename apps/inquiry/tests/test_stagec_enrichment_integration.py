"""Opt-in Stage C contract against the disposable local PostgREST instance."""

from __future__ import annotations

import os
import uuid

import pytest
from postgrest import SyncPostgrestClient

from src.supabase_client import SupabaseClient


REST_URL = os.environ.get("STAGE_C_REST_URL", "")
SERVICE_ROLE_KEY = os.environ.get("STAGE_C_SERVICE_ROLE_KEY", "")


@pytest.mark.skipif(
    not REST_URL or not SERVICE_ROLE_KEY,
    reason="local Stage C PostgREST bindings are not configured",
)
def test_enrichment_adapter_uses_canonical_ids_and_idempotent_uuid_links():
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    postgrest = SyncPostgrestClient(REST_URL, headers=headers)
    suffix = uuid.uuid4().hex[:12].upper()
    product_variant_id = str(uuid.uuid4())
    item_code = f"ENRICH{suffix}"
    inquiry_id = None
    try:
        postgrest.table("product_variants").insert({
            "id": product_variant_id,
            "sku": item_code,
            "item_code": item_code,
            "variant_name": "日本語エンリッチ商品",
            "stock_qty": 4,
            "status": "active",
        }).execute()
        inquiry_rows = postgrest.table("inquiries").insert({
            "source": "mercari_shops",
            "external_inquiry_id": f"enrichment-stage-c-{suffix}",
            "shop_key": "shop3",
            "status": "received",
            "inquiry_date": "2026-07-21T03:00:00Z",
            "inquiry_body": "日本語エンリッチ問い合わせ",
        }).execute().data
        inquiry_id = inquiry_rows[0]["id"]

        client = SupabaseClient(
            url="http://local-stage-c.invalid",
            service_role_key=SERVICE_ROLE_KEY,
            writes_enabled=True,
            client=postgrest,
        )
        assert client.get_inquiry_by_id(inquiry_id)["external_inquiry_id"].startswith(
            "enrichment-stage-c-"
        )
        product = client.find_product_variant_by_item_code(item_code)
        assert product["id"] == product_variant_id

        first = client.create_inquiry_product_link(
            inquiry_id,
            product_variant_id,
            item_code,
            product_name="日本語エンリッチ商品",
            is_primary=True,
        )
        second = client.create_inquiry_product_link(
            inquiry_id,
            product_variant_id,
            item_code,
            product_name="ignored duplicate",
            is_primary=True,
        )
        assert first["id"] == second["id"]
        links = (
            postgrest.table("inquiry_product_links")
            .select("product_variant_id,link_source,is_primary")
            .eq("inquiry_id", inquiry_id)
            .execute()
            .data
        )
        assert links == [{
            "product_variant_id": product_variant_id,
            "link_source": "enrichment",
            "is_primary": True,
        }]

        client.update_inquiry(inquiry_id, {"mercari_variant_name": "日本語バリエーション"})
        updated = (
            postgrest.table("inquiries")
            .select("mercari_variant_name")
            .eq("id", inquiry_id)
            .single()
            .execute()
            .data
        )
        assert updated["mercari_variant_name"] == "日本語バリエーション"
    finally:
        if inquiry_id is not None:
            postgrest.table("inquiries").delete().eq("id", inquiry_id).execute()
        postgrest.table("product_variants").delete().eq(
            "id", product_variant_id
        ).execute()
