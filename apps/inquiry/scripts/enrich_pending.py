"""
Enrich all pending Mercari inquiries by extracting fields via browser automation.

Usage:
    python3 scripts/enrich_pending.py [--dry-run] [--limit N] [--confirm]
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
        description="Enrich pending Mercari inquiries via browser extraction"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate without writing to Supabase",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Max inquiries to process (default: 5)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Prompt before writing each inquiry to Supabase",
    )
    parser.add_argument(
        "--since-hours",
        type=int,
        default=None,
        help="Only process inquiries created within this many hours (default: no filter)",
    )
    args = parser.parse_args()

    config = EnrichmentConfig()

    if args.confirm and not args.dry_run:
        response = input(
            f"\nAbout to process up to {args.limit} inquiries "
            f"and write results to Supabase. Continue? [y/N]: "
        )
        if response.strip().lower() != "y":
            print("Aborted by user.")
            sys.exit(EXIT_FAIL)

    extractor = MercariExtractor(config, dry_run=args.dry_run)
    result = extractor.enrich_pending(limit=args.limit, since_hours=args.since_hours)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    sys.exit(EXIT_OK if result.get("ok") else EXIT_FAIL)


if __name__ == "__main__":
    main()
