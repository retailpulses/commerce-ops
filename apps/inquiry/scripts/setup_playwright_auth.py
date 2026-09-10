"""
One-time setup: log into Mercari Shops for Playwright-based enrichment.

Launches headed Chrome with a dedicated (non-default) user-data directory
so Chrome permits DevTools remote debugging.  Log in once per shop;
the session is stored in IndexedDB / Service Workers and reused by the
extractor for headless extraction runs.

Usage:
    python3 scripts/setup_playwright_auth.py <shop_name>
    python3 scripts/setup_playwright_auth.py --list   # show known shops
    python3 scripts/setup_playwright_auth.py --all     # setup all shops
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from src.enrichment.config import EnrichmentConfig

EXIT_OK = 0
EXIT_FAIL = 1

MERCARI_SELLER_HOME = "https://mercari-shops.com/seller"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set up Playwright auth state for a Mercari Shops account"
    )
    parser.add_argument(
        "shop",
        nargs="?",
        help="Shop name as in config.yaml enrichment.shop_profiles (e.g. Shop1)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List known shops and their status",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Set up all shops one by one",
    )
    parser.add_argument(
        "--no-prompt",
        action="store_true",
        help="Skip interactive prompts (for running via Claude Code etc.)",
    )
    args = parser.parse_args()

    config = EnrichmentConfig()
    shop_profiles = config.enrichment_shop_profiles
    chrome_data_dir = config.enrichment_chrome_data_dir

    if args.list:
        print(f"Chrome data dir: {chrome_data_dir}")
        print(f"Profiles exist:  {Path(chrome_data_dir).is_dir()}")
        print()
        print("Shops:")
        for name, profile in shop_profiles.items():
            profile_path = Path(chrome_data_dir) / profile
            has_prefs = (profile_path / "Preferences").exists()
            has_cookies = (profile_path / "Cookies").exists()
            status = "✓ exists" if has_prefs else "✗ not set up"
            print(f"  {name} → {profile}  ({status})")
        return

    if args.all:
        shops = list(shop_profiles.keys())
    elif args.shop:
        if args.shop not in shop_profiles:
            print(f"Error: unknown shop '{args.shop}'. Known: {', '.join(shop_profiles)}")
            sys.exit(EXIT_FAIL)
        shops = [args.shop]
    else:
        print("Error: specify a shop name, --list, or --all")
        sys.exit(EXIT_FAIL)

    chrome_data_path = Path(chrome_data_dir)
    chrome_data_path.mkdir(parents=True, exist_ok=True)

    for shop in shops:
        profile = shop_profiles[shop]
        _setup_shop(config, shop, profile, no_prompt=args.no_prompt)


def _setup_shop(config: EnrichmentConfig, shop: str, profile: str, no_prompt: bool = False) -> None:
    chrome_data_dir = config.enrichment_chrome_data_dir

    print(f"{'='*60}")
    print(f"Setting up:  {shop}")
    print(f"Profile:     {profile}")
    print(f"Data dir:    {chrome_data_dir}")
    print(f"{'='*60}")
    print()

    if not no_prompt:
        print("Chrome will open. Log into Mercari Shops manually, then")
        print("press Enter here once you're on the seller dashboard.")
        print()
        input("Press Enter to launch Chrome...")
    else:
        print("Launching Chrome (non-interactive mode)...")

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=chrome_data_dir,
                headless=False,
                channel="chrome",
                args=[
                    f"--profile-directory={profile}",
                    "--no-first-run",
                    f"--window-name=Mercari Auth: {shop}",
                ],
            )
            page = context.new_page()

            # Navigate to Mercari seller dashboard
            print("Navigating to Mercari Shops seller dashboard...")
            page.goto(
                MERCARI_SELLER_HOME,
                wait_until="domcontentloaded",
                timeout=30000,
            )

            # Wait for JS redirect to complete (Mercari SPA redirects to
            # signin a few seconds after initial load if not authed)
            page.wait_for_timeout(8000)

            # Re-read URL after JS has settled
            current_url = page.url
            print(f"Current URL: {current_url}")

            if "signin" in current_url or "login" in current_url.lower():
                print()
                print("Not authenticated — please log in manually.")
                print("Waiting for you to reach the seller dashboard...")
                print("(The script continues automatically once detected)")
                print()

                # Wait until the seller dashboard loads (up to 3 minutes)
                try:
                    page.wait_for_url(
                        f"{MERCARI_SELLER_HOME}**",
                        timeout=180_000,
                    )
                    print("Seller dashboard detected!")
                except Exception:
                    print()
                    print("Timeout waiting for login (180s).")
                    if not no_prompt:
                        print("If you're logged in, press Enter to continue...")
                        input()

            else:
                print("Already authenticated ✓")

            # Verify by navigating to the seller settings page (requires
            # auth, account-level — not tied to any specific shop)
            print()
            print("Verifying auth with seller settings page...")
            verify_url = "https://mercari-shops.com/seller/settings"
            page.goto(verify_url, wait_until="domcontentloaded",
                      timeout=30000)
            page.wait_for_timeout(5000)
            verify_current = page.url
            print(f"Verify URL: {verify_current}")

            if "signin" in verify_current or "login" in verify_current.lower():
                print()
                print("AUTH FAILED — settings page redirected to signin.")
                print("Please log in manually in the Chrome window...")
                print("Waiting up to 3 minutes for login...")
                try:
                    page.wait_for_url(
                        "**/seller/settings**",
                        timeout=180_000,
                    )
                    print("Login detected on settings page!")
                except Exception:
                    print()
                    print("Timeout waiting for login (180s).")
                    if not no_prompt:
                        print("If you're logged in, press Enter to continue...")
                        input()
            else:
                print("Auth verified on settings page ✓")

            context.close()

    except Exception as e:
        msg = str(e)
        if "lock" in msg.lower() or "profile" in msg.lower():
            print(f"\nProfile in use — close other Chrome windows and retry.")
        else:
            print(f"\nError: {e}")
        sys.exit(EXIT_FAIL)

    print(f"✓ {shop} setup complete.")
    print()


if __name__ == "__main__":
    main()
