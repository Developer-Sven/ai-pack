# Single-VPS deployment (systemd or Compose, Caddy/nginx, backups, firewall)

A small VPS runs many production apps well. What breaks them is not scale but operations: a deploy
that drops requests, a disk full of logs, a database port open to the internet, and backups that were
never restored. This reference assumes Debian/Ubuntu, one app (Node shown; Python works the same),
a local database (SQLite or Postgres) and TLS via Caddy.

## 1. Layout

```text
/srv/app/releases/<git-sha>/   immutable build artifacts (built in CI, not on the server)
/srv/app/current -> releases/<git-sha>   symlink switched atomically on deploy
/var/lib/app/                  data (SQLite files, uploads) - owned by the app user, backed up
/etc/app/env                   environment file, root:app 0640, never in git
```

Create a system user without a shell: `useradd --system --home /srv/app --shell /usr/sbin/nologin app`.

## 2. systemd unit (two instances for zero-downtime swaps)

`/etc/systemd/system/app@.service` - instance name = port:

```ini
[Unit]
Description=app on port %i
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=app
Group=app
WorkingDirectory=/srv/app/current
EnvironmentFile=/etc/app/env
Environment=PORT=%i NODE_ENV=production
ExecStart=/usr/bin/node --enable-source-maps server.js
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
# above the app's own shutdown budget (drain requests, close DB). systemd has no end-of-line comments:
# "TimeoutStopSec=30  # ..." would be rejected and the 90 s default used instead.
TimeoutStopSec=30
LimitNOFILE=65536
MemoryMax=1G

# hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/app
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now app@3001`. The app binds to `127.0.0.1` only; Caddy is the public entry.
With SQLite, both instances may run concurrently on one host (WAL + busy_timeout,
`sqlite-patterns`); background schedulers must run in one instance only (`background-jobs`).

## 3. Caddy (automatic TLS, health-checked upstreams)

```caddyfile
app.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3001 127.0.0.1:3002 {
		lb_policy first          # all traffic to the first healthy instance
		health_uri /readyz
		health_interval 5s
		fail_duration 30s
		lb_try_duration 5s       # retry another upstream while one restarts
	}
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	log {
		output file /var/log/caddy/app.log {
			roll_size 50MiB
			roll_keep 10
		}
	}
}
```

nginx + certbot is equivalent (upstream block with `max_fails`/`fail_timeout`, `proxy_next_upstream
error timeout http_502 http_503`); WebSocket/SSE settings in `realtime-patterns/references/operations.md`.

## 4. Deploy script (build in CI, switch atomically, roll back fast)

```bash
#!/usr/bin/env bash
set -euo pipefail
SHA="$1"; REL="/srv/app/releases/$SHA"
# 1. artifact already uploaded by CI (rsync/scp of the build output incl. node_modules from `npm ci --omit=dev`)
test -d "$REL"
# 2. migrations once, before traffic moves; must be backward compatible with the running version
sudo -u app bash -c "cd '$REL' && set -a && . /etc/app/env && set +a && node scripts/migrate.js"
# 3. switch the symlink atomically, restart instances one by one, wait for readiness
ln -sfn "$REL" /srv/app/current.new && mv -T /srv/app/current.new /srv/app/current
for port in 3001 3002; do
  systemctl restart "app@$port"
  for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null || { echo "instance $port not ready"; exit 1; }
done
# 4. keep the active release plus the 4 newest others for rollback (never delete what `current` points at)
ls -1dt /srv/app/releases/*/ | grep -vF "/releases/$SHA/" | tail -n +5 | xargs -r rm -rf
```

Rollback = point `current` at the previous release and restart the instances the same way (schema
changes stay backward compatible for exactly this reason: expand/contract, `database-migrations`).

Compose instead of systemd: tag images by git SHA, `docker compose pull && docker compose up -d
--wait` (healthcheck-gated), keep two replicas behind Caddy for swaps, and never build images on the
server.

## 5. Firewall and SSH

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow 80/tcp && ufw allow 443/tcp
ufw allow from <admin-ip-or-vpn-range> to any port 22 proto tcp
ufw enable
```

- **Docker bypasses ufw**: published ports (`ports: ["5432:5432"]`) are opened in iptables directly,
  ignoring ufw rules. Publish only what must be public, and bind the rest to loopback:
  `ports: ["127.0.0.1:5432:5432"]` - or do not publish database ports at all (use the compose network).
- Databases listen on `127.0.0.1` / a private network only (`listen_addresses`, `bind-address`,
  `net.bindIp`); never rely on the database password alone.
- SSH: keys only (`PasswordAuthentication no`, `PermitRootLogin no`), fail2ban/CrowdSec, or SSH only
  over a VPN (WireGuard/Tailscale). `unattended-upgrades` for security patches; reboot windows planned.

## 6. Backups that restore

- Nightly **off-box**, encrypted, versioned: `restic` or `borg` to S3/B2/R2 with a retention policy
  (e.g. 7 daily, 4 weekly, 12 monthly).
- Back up a consistent database copy, not live files: `pg_dump -Fc`, SQLite online backup /
  `VACUUM INTO` / Litestream (`sqlite-patterns`), `mongodump`; plus uploads and `/etc/app`.
- **Restore drill** on a scratch VM monthly: restore, start the app against it, run a smoke test.
  Alert when the newest backup is older than 26 hours.

## 7. Logs, disks, monitoring

- journald cap: `SystemMaxUse=1G` in `/etc/systemd/journald.conf`; file logs rotated (logrotate or
  Caddy's `roll_*`). Full disks are the most common single-VPS outage (logs, backups, uploads).
- External uptime check on `/readyz` from outside the provider's network; alerts on disk > 80 %,
  memory, restarts (`systemctl --failed`), certificate expiry (Caddy renews, still monitor).
- Ship logs and metrics off the box if the VPS matters (Vector/Promtail/OTel collector), so an
  incident does not destroy its own evidence.

## 8. Checklist

- [ ] Build in CI; artifacts or images addressed by git SHA; nothing compiled on the server
- [ ] Non-root service user; systemd hardening or rootless containers; secrets in `/etc/app/env` 0640
- [ ] Two instances behind a health-checking proxy; readiness-gated restarts; one-command rollback
- [ ] Migrations run once per deploy, backward compatible; background schedulers single-instance
- [ ] Firewall default deny; only 80/443 public; DB ports loopback-only (Docker publish trap checked)
- [ ] SSH keys only, patches automatic; TLS automatic and monitored
- [ ] Off-box encrypted backups with retention; monthly restore drill; backup-age alert
- [ ] Log/journal caps, disk alerts, external uptime check
