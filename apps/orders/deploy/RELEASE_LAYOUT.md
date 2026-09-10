# Portal Release Layout (Issue 60)

Immutable, atomic-swap deployment for the OrderMgmt Portal API + SPA.

## Layout on the VPS

```
/opt/order-mgmt/
  releases/<sha>/          # immutable release: source + portal/dist + node_modules
  current -> releases/<sha>  # symlink, swapped atomically on deploy/rollback
  .previous-release        # path of the release before the last swap (rollback aid)
  .env                     # protected env (secrets + RELEASE_SHA) — OUTSIDE releases
```

- The legacy git clone `/opt/OrderMgmt` is now a **fetch source only**: deploy
  resolves the target SHA there and materializes each release via `git archive`.
- nginx root and the systemd unit both reference `/opt/order-mgmt/current`, never
  a bare SHA path, so a deploy or rollback is a single symlink repoint + restart.
- Secrets never live inside a release; they live in `/opt/order-mgmt/.env`
  (systemd `EnvironmentFile=`), which survives every swap and every prune.

## Canonical paths (Issue 60)

| URL | Served by |
|-----|-----------|
| `/order/` + `/order/assets/*` | SPA (Vite `base: /order/`) via nginx `alias` |
| `/order/api/portal/*` | portal-api (normalizes → `/api/portal/*`) |
| `/order/api/release` | public read-only release metadata (contract v1) |
| `/` + `/api/*` | legacy root, retained for rollback compatibility |

## Deploy

Trigger `deploy-api.yml` with `ref` = branch/tag/SHA (default `main` HEAD).
The workflow resolves the exact 40-char SHA, materializes (or reuses)
`releases/<sha>`, syncs the protected env (injecting `RELEASE_SHA` +
`RELEASE_BUILT_AT`), swaps the `current` symlink atomically, installs the
systemd unit + nginx config, and smoke-tests `/api/release` returns the SHA.

## Rollback

Use the Git-managed rollback command with the exact target SHA:

```bash
sudo /usr/local/sbin/order-release-rollback <40-character-release-sha>
```

Run the same command with `--check` before an operator-initiated rollback to
validate the target without changing production:

```bash
sudo /usr/local/sbin/order-release-rollback --check <40-character-release-sha>
```

The command validates the target, atomically updates `current`, synchronizes the
shared release metadata, installs that release's systemd/Nginx configuration,
normalizes SPA permissions, and verifies health plus the exact release SHA. If
any step fails, it restores the previous pointer, environment, and service
configuration before restarting the previous release.

Or re-run `deploy-api.yml` with `ref` set to a known-good SHA/tag — this
re-materializes that release and swaps `current` to it.

## Cleanup

Old releases are intentionally **not** auto-pruned (safety). To reclaim space
after several successful deploys, remove releases older than the last N, but
never the release currently pointed to by `current` or listed in
`.previous-release`.
