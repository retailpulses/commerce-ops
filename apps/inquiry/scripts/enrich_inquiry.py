"""
Enrich a single Mercari inquiry by extracting fields via browser automation.

Usage:
    python3 scripts/enrich_inquiry.py <inquiry_id> [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys

from src.enrichment.config import EnrichmentConfig
from src.enrichment.extractor import MercariExtractor


EXIT_OK = 0
EXIT_FAIL = 1


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Enrich a single Mercari inquiry via browser extraction"
    )
    parser.add_argument(
        "inquiry_id",
        type=int,
        help="Canonical Supabase inquiry ID to enrich",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate without writing to Supabase",
    )
    args = parser.parse_args()

    config = EnrichmentConfig()
    extractor = MercariExtractor(config, dry_run=args.dry_run)
    result = extractor.enrich_one(args.inquiry_id)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK if result.get("ok") else EXIT_FAIL)


if __name__ == "__main__":
    main()
