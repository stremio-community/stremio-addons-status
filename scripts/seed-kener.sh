#!/bin/sh
# One-shot Kener seed, run by the kener-seed compose service on stack startup (idempotent).
# Creates the admin user via the signup endpoint (only possible while no user exists) and
# upserts the worker's API key directly in Postgres, so KENER_API_TOKEN from .env just works
# without clicking through the manage UI wizard.
#
# Runs inside the postgres:16-alpine image: busybox wget for HTTP, psql + pgcrypto for the key hash
# (Kener stores hmac_sha256(KENER_SECRET_KEY, token) — deterministic, so we can compute it here).
set -eu

: "${KENER_INTERNAL_URL:=http://kener:3000}"

for v in POSTGRES_USER POSTGRES_DB KENER_PUBLIC_URL KENER_SECRET_KEY KENER_API_TOKEN KENER_ADMIN_EMAIL KENER_ADMIN_PASSWORD; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "seed: $v is required" >&2
    exit 1
  fi
done

sql() {
  psql -v ON_ERROR_STOP=1 -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA "$@"
}

# Wait for Kener to finish its migrations and start serving.
# /healthcheck is the only route that renders host-agnostically, so probe that.
i=0
until wget -q -O /dev/null "$KENER_INTERNAL_URL/healthcheck" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "seed: kener not reachable after 120s, giving up" >&2
    exit 1
  fi
  sleep 2
done

# Admin user. The signup action only works while the users table is empty, which makes this naturally idempotent.
# Note: email/password go form-encoded, so KENER_ADMIN_PASSWORD must avoid characters that need URL-encoding (& = % +).
users=$(sql -c "SELECT count(*) FROM users;")
if [ "$users" = "0" ]; then
  # SvelteKit's CSRF check requires the Origin header to match Kener's ORIGIN env (KENER_PUBLIC_URL).
  resp=$(wget -q -O- \
    --header "Origin: $KENER_PUBLIC_URL" \
    --post-data "name=Admin&email=$KENER_ADMIN_EMAIL&password=$KENER_ADMIN_PASSWORD" \
    "$KENER_INTERNAL_URL/account/signin?/signup" 2>&1 || true)
  users=$(sql -c "SELECT count(*) FROM users;")
  if [ "$users" = "0" ]; then
    echo "seed: admin user creation failed: $resp" >&2
    exit 1
  fi
  echo "seed: created admin user $KENER_ADMIN_EMAIL"
else
  echo "seed: users already exist, skipping admin creation"
fi

# Worker API key: upsert the hash of KENER_API_TOKEN so the key in .env is always valid.
# psql only interpolates :'var' from stdin scripts, not -c strings.
sql -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null
printf '%s\n' "
  INSERT INTO api_keys (name, hashed_key, masked_key)
  VALUES ('worker', encode(hmac(:'tok', :'sec', 'sha256'), 'hex'), left(:'tok', 6) || '****' || right(:'tok', 4))
  ON CONFLICT (name) DO UPDATE
    SET hashed_key = EXCLUDED.hashed_key, masked_key = EXCLUDED.masked_key, updated_at = now();
" | sql -v tok="$KENER_API_TOKEN" -v sec="$KENER_SECRET_KEY" >/dev/null
echo "seed: worker API key upserted"

# Prove the key works before letting the worker loose on it.
if ! wget -q -O /dev/null --header "Authorization: Bearer $KENER_API_TOKEN" "$KENER_INTERNAL_URL/api/v4/monitors"; then
  echo "seed: API key verification against /api/v4/monitors failed" >&2
  exit 1
fi
echo "seed: API key verified, done"
