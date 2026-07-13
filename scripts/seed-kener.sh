#!/bin/sh
# One-shot Kener seed, run by the kener-seed compose service on stack startup (idempotent).
# Creates the admin user via the signup endpoint (only possible while no user exists), then applies
# seed-kener.sql, which registers KENER_API_TOKEN as the worker's API key and defines the static
# monitors — so a fresh stack is fully set up without clicking through the manage UI wizard.
#
# Runs inside the postgres:16-alpine image: busybox wget for HTTP, psql for the SQL.
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

# Seed data: worker API key + static monitors. See seed-kener.sql.
sql -v tok="$KENER_API_TOKEN" -v sec="$KENER_SECRET_KEY" -f /seed-kener.sql >/dev/null
echo "seed: applied seed-kener.sql (worker API key + static monitors)"

# Prove the key works before letting the worker loose on it.
if ! wget -q -O /dev/null --header "Authorization: Bearer $KENER_API_TOKEN" "$KENER_INTERNAL_URL/api/v4/monitors"; then
  echo "seed: API key verification against /api/v4/monitors failed" >&2
  exit 1
fi
echo "seed: API key verified, done"
