# Production deployment (single server)

Deployed 2026-10-30 to `dilmune@143.110.252.107` (DigitalOcean, Ubuntu 24.04, 1 CPU, 2 GB RAM).

| What | Address |
|---|---|
| Merchant dashboard | https://app.143-110-252-107.sslip.io |
| Admin console | https://admin.143-110-252-107.sslip.io |
| API | https://api.143-110-252-107.sslip.io (`/healthz`, `/readyz`) |

The names are free wildcard DNS (sslip.io) for the server IP, with real Let's Encrypt certificates. They are fine for testing; for real customers use your own domain (point `app`, `admin`, `api` at the IP, change `APP_HOST`/`ADMIN_HOST`/`API_HOST` in `.env.prod`, rebuild the two frontends with the new URLs, restart).

## Layout on the server (`/opt/filspay`)
- `src/` the uploaded code (`ops/docker-compose.prod.yml`, `ops/Caddyfile`)
- `www/web`, `www/admin` the built frontends served by Caddy
- `.env.prod` secrets generated on the server (mode 600, never committed): database password, internal token, webhook encryption key, callback secret, email key

Services (Docker, restart automatically): `postgres` (private, no public port), `migrate` (one-off), `api`, `settlement`, `reporting`, `caddy` (ports 80/443 only). Firewall: 22, 80, 443.

## Finish email (required before anyone can sign in)
Gmail SMTP is blocked by DigitalOcean (ports 25/465/587). Use Resend (HTTPS):
1. Create a Resend account with `fils.pay01@gmail.com` and an API key. Without a verified domain Resend delivers only to that account's own address (enough for the master). To email everyone, verify a domain you own and set `OTP_FROM_EMAIL` to an address on it.
2. On the server: put the key in `/opt/filspay/.env.prod` as `RESEND_API_KEY=re_...`
3. Restart the API and send the master's password link:
```sh
cd /opt/filspay
C="sudo docker compose --env-file .env.prod -f src/ops/docker-compose.prod.yml"
$C up -d api
$C exec -T api npx tsx apps/api/src/cli/master.ts reset --setup-email
```

## Update the code
```sh
# from your computer, repo root
rsync -az --delete --exclude node_modules --exclude .git --exclude '.claude' --exclude 'apps/*/dist' \
  --exclude 'ops/.env.mail' --exclude 'ops/.env.docker' --exclude docs --exclude '*.md' \
  --exclude 'db/seed/fixtures/production_seed.sql' ./ dilmune@143.110.252.107:/opt/filspay/src/
# frontends: build with the production URLs, then rsync dist to /opt/filspay/www/{web,admin}
# on the server
cd /opt/filspay && C="sudo docker compose --env-file .env.prod -f src/ops/docker-compose.prod.yml"
$C build && $C up -d
```

## Useful commands (on the server)
```sh
$C ps                      # status
$C logs -f api             # API log
$C exec -T postgres pg_dump -U filspay filspay | gzip > backups/filspay-$(date +%F).sql.gz   # manual backup
```

## Known limits
- The acquirer is still a simulator: no real card payments.
- No automatic backups are scheduled yet (ask before adding a cron job).
- Single server, in-memory rate limits; fine for one API container.
