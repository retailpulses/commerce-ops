"""Tests for the canonical Supabase-backed Mercari enrichment runtime."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from src.enrichment.error import CodexError, EnrichmentError
from src.enrichment.extractor import EXTRACTION_SCRIPT, INQUIRY_FIELD_MAP, MercariExtractor


PRODUCT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _make_config(**overrides):
    cfg = MagicMock()
    cfg.supabase_url = "http://127.0.0.1:55431"
    cfg.supabase_service_role_key = "local-test-key"
    cfg.inquiry_enrichment_writes_enabled = True
    cfg.log_file = ".runtime/test_runs.jsonl"
    cfg.enrichment_chrome_data_dir = "/tmp/fake-chrome"
    cfg.enrichment_headless = True
    cfg.enrichment_timeout = 120
    cfg.enrichment_default_profile = "Default"
    cfg.enrichment_shop_profiles = {
        "shop1": "Profile 3",
        "shop2": "Profile 2",
        "shop3": "Profile 1",
        "shop4": "Default",
    }
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def _make_extractor(*, dry_run=False):
    client = MagicMock()
    return MercariExtractor(
        _make_config(), dry_run=dry_run, supabase_client=client
    ), client


def _sample_extraction(**overrides):
    data = {
        "customerName": "すず",
        "productId": "2JMjuSS6rG5aGzfeLZT8he",
        "variantName": "ベージュ",
        "messageContent": "この商品のサイズを教えてください。",
        "skuCode": "PH315189BAA",
    }
    data.update(overrides)
    return data


def _row(inquiry_id=1, **overrides):
    row = {
        "id": inquiry_id,
        "url": f"https://mercari-shops.com/seller/shops/X/inquiries/{inquiry_id}",
        "shop_key": "shop1",
        "customer_nickname": None,
        "mercari_product_id": None,
        "mercari_variant_name": None,
        "last_custom_message": None,
        "inquiry_body": "商品について質問です",
    }
    row.update(overrides)
    return row


class TestCanonicalPayload:
    def test_maps_all_extraction_keys(self):
        extractor, _ = _make_extractor()
        payload = extractor._build_payload(_sample_extraction())
        assert payload == {
            "customer_nickname": "すず",
            "mercari_product_id": "2JMjuSS6rG5aGzfeLZT8he",
            "mercari_variant_name": "ベージュ",
            "last_custom_message": "この商品のサイズを教えてください。",
        }

    def test_skips_null_values_and_sku(self):
        extractor, _ = _make_extractor()
        payload = extractor._build_payload(
            _sample_extraction(customerName=None, variantName=None)
        )
        assert "customer_nickname" not in payload
        assert "mercari_variant_name" not in payload
        assert "skuCode" not in payload
        assert payload["mercari_product_id"] == "2JMjuSS6rG5aGzfeLZT8he"

    def test_empty_extraction_returns_empty_payload(self):
        extractor, _ = _make_extractor()
        assert extractor._build_payload({}) == {}


class TestSelection:
    def test_already_enriched_uses_canonical_columns(self):
        extractor, _ = _make_extractor()
        assert extractor._already_enriched(
            _row(
                customer_nickname="すず",
                mercari_product_id="abc",
                mercari_variant_name="ベージュ",
                last_custom_message="サイズは？",
            )
        )
        assert not extractor._already_enriched(_row(last_custom_message=""))

    def test_pending_skips_missing_url_and_respects_limit(self):
        extractor, client = _make_extractor(dry_run=True)
        client.list_inquiries_pending_enrichment.return_value = [
            _row(1, url=None),
            _row(2),
            _row(3),
            _row(4),
        ]
        result = extractor.enrich_pending(limit=2)
        assert result["counters"] == {
            "fetched": 4,
            "enriched": 2,
            "skipped": 1,
            "failed": 0,
        }
        client.list_inquiries_pending_enrichment.assert_called_once_with(
            limit=2, since_hours=None
        )


class TestDryRun:
    def test_dry_run_is_browser_and_database_immutable(self):
        extractor, client = _make_extractor(dry_run=True)
        with patch.object(extractor, "_extract_via_playwright") as browser:
            result = extractor._enrich_row(_row(42), "run-id")
        assert result["ok"] is True
        assert result["dry_run"] is True
        assert result["inquiry_id"] == 42
        assert result["chrome_profile"] == "Profile 3"
        browser.assert_not_called()
        client.update_inquiry.assert_not_called()
        client.create_inquiry_product_link.assert_not_called()

    def test_dry_run_exposes_canonical_current_values(self):
        extractor, _ = _make_extractor(dry_run=True)
        result = extractor._enrich_row(
            _row(1, customer_nickname="たなか", last_custom_message="既存の本文"),
            "run-id",
        )
        assert result["current_values"]["customer_nickname"] == "たなか"
        assert result["current_values"]["last_custom_message"] == "既存の本文"


class TestLiveEnrichment:
    def test_writes_canonical_uuid_link_and_inquiry_fields(self):
        extractor, client = _make_extractor()
        client.find_product_variant_by_item_code.return_value = {
            "id": PRODUCT_UUID,
            "item_code": "PH315189BAA",
            "variant_name": "ベージュ",
        }
        with patch.object(
            extractor, "_extract_via_playwright", return_value=_sample_extraction()
        ):
            result = extractor._enrich_row(_row(42), "run-id")
        assert result["ok"] is True
        client.create_inquiry_product_link.assert_called_once_with(
            inquiry_id=42,
            product_variant_id=PRODUCT_UUID,
            item_code="PH315189BAA",
            product_name="ベージュ",
            is_primary=True,
        )
        client.update_inquiry.assert_called_once()
        assert client.update_inquiry.call_args.args[0] == 42
        assert client.update_inquiry.call_args.args[1]["customer_nickname"] == "すず"

    def test_enrich_one_looks_up_canonical_inquiry_id(self):
        extractor, client = _make_extractor(dry_run=True)
        client.get_inquiry_by_id.return_value = _row(42, shop_key="shop2")
        result = extractor.enrich_one(42)
        assert result["ok"] is True
        assert result["inquiry_id"] == 42
        assert result["chrome_profile"] == "Profile 2"
        client.get_inquiry_by_id.assert_called_once_with(42)

    def test_enrich_one_not_found(self):
        extractor, client = _make_extractor()
        client.get_inquiry_by_id.return_value = None
        result = extractor.enrich_one(999)
        assert result["ok"] is False
        assert "id=999" in result["error"]


class TestGuardrails:
    def test_rejects_non_mercari_url(self):
        extractor, client = _make_extractor()
        result = extractor._enrich_row(_row(url="https://example.com/inquiry/1"), "run-id")
        assert result["ok"] is False
        client.update_inquiry.assert_not_called()

    def test_profile_falls_back_safely(self):
        extractor, _ = _make_extractor()
        assert extractor._resolve_profile("shop3") == "Profile 1"
        assert extractor._resolve_profile("unknown") == "Default"
        assert extractor._resolve_profile("") == "Default"

    def test_error_hierarchy_and_extraction_asset(self):
        assert issubclass(CodexError, EnrichmentError)
        assert EXTRACTION_SCRIPT.exists()
        assert "messageContent" in EXTRACTION_SCRIPT.read_text()
        assert set(INQUIRY_FIELD_MAP) == {
            "customerName", "productId", "variantName", "messageContent"
        }
