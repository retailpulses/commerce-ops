"""Unit contracts for the VPS PostgREST adapter."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.errors import SupabaseError
from src.supabase_client import SupabaseClient


PRODUCT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _client(*, writes_enabled=True):
    api = MagicMock()
    query = MagicMock()
    api.table.return_value = query
    for method in ("select", "eq", "limit", "insert", "update", "is_", "not_", "or_", "order", "gte"):
        getattr(query, method).return_value = query
    client = SupabaseClient.__new__(SupabaseClient)
    client._client = api
    client.writes_enabled = writes_enabled
    return client, api, query


def _response(data):
    return SimpleNamespace(data=data, error=None)


def test_get_inquiry_uses_canonical_id():
    client, api, query = _client()
    query.execute.return_value = _response([{"id": 42}])
    assert client.get_inquiry_by_id(42) == {"id": 42}
    api.table.assert_called_once_with("inquiries")
    query.eq.assert_called_once_with("id", 42)


def test_product_link_rejects_non_uuid_before_insert():
    client, _api, query = _client()
    with pytest.raises(SupabaseError, match="Invalid product_variants UUID"):
        client.create_inquiry_product_link(42, "not-a-uuid", "SKU-1")
    query.insert.assert_not_called()


def test_product_link_is_fail_closed():
    client, _api, query = _client(writes_enabled=False)
    with pytest.raises(RuntimeError, match="writes are disabled"):
        client.create_inquiry_product_link(42, PRODUCT_UUID, "SKU-1")
    query.insert.assert_not_called()


def test_existing_operator_link_is_returned_without_mutation():
    client, _api, query = _client()
    existing = {
        "id": 7,
        "inquiry_id": 42,
        "product_variant_id": PRODUCT_UUID,
        "item_code_snapshot": "SKU-1",
        "link_source": "operator",
    }
    query.execute.return_value = _response([existing])
    assert client.create_inquiry_product_link(42, PRODUCT_UUID, "SKU-1") == existing
    query.insert.assert_not_called()


def test_new_product_link_uses_uuid_and_preserves_existing_primary():
    client, _api, query = _client()
    created = {"id": 8, "product_variant_id": PRODUCT_UUID, "is_primary": False}
    query.execute.side_effect = [
        _response([]),
        _response([{"id": 2}]),
        _response([created]),
    ]
    result = client.create_inquiry_product_link(
        42,
        PRODUCT_UUID,
        "SKU-1",
        product_name="商品",
        is_primary=True,
        confidence=0.876,
    )
    assert result == created
    payload = query.insert.call_args.args[0]
    assert payload["product_variant_id"] == PRODUCT_UUID
    assert payload["is_primary"] is False
    assert payload["link_source"] == "enrichment"
    assert payload["confidence"] == 0.88
