#!/usr/bin/env bash
set +e
cd deploy/runtime
hex(){ openssl rand -hex 32; }
cat > .env <<EOF
ELESEND_DOMAIN=example.test
POSTGRES_PASSWORD=auditpw$(openssl rand -hex 8)
OTP_KEY=$(hex)
ADMIN_MFA_ENCRYPTION_KEY=$(hex)
JWT_SECRET=$(hex)
ADMIN_MASTER_KEY=$(hex)
AUDIT_LOG_SECRET=$(hex)
READINESS_PROBE_TOKEN=$(hex)
GHANA_MAP_DATA=/tmp/map-data
DATABASE_SSL=false
EOF
source .env
echo "DOCKER_DATABASE_URL=postgres://elesend:$POSTGRES_PASSWORD@db:5432/elesend" >> .env
mkdir -p /tmp/map-data
say(){ echo "AUDITSTACK $*"; }
say "compose config: $(docker compose config -q 2>&1 | head -5; echo rc=${PIPESTATUS[0]})"
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e ELESEND_API_HOST=api.example.test -e WEB_HOST=app.example.test -e ADMIN_HOST=admin.example.test -e MAPS_HOST=maps.example.test -e 'ADMIN_ALLOWED_IPS=0.0.0.0/0 ::/0' caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3 | sed 's/^/AUDITSTACK caddy validate: /'
sed -i -E 's/^(\{\$[A-Z_]+\}) \{$/\1 {\n  tls internal/' Caddyfile
docker compose build api 2>&1 | tail -3
docker compose up -d db redis 2>&1 | tail -2
docker compose run --rm migrate 2>&1 | tail -3 | sed 's/^/AUDITSTACK migrate: /'
docker compose up -d --no-deps api 2>&1 | tail -2
sleep 25
say "api state: $(docker compose ps api --format '{{.State}} {{.Health}}')"
docker compose logs api --tail 12 2>&1 | cut -c1-260 | sed 's/^/AUDITSTACK api log: /'
docker compose up -d --no-deps caddy 2>&1 | tail -2
sleep 12
say "caddy state: $(docker compose ps caddy --format '{{.State}}')"
docker compose logs caddy --tail 6 2>&1 | cut -c1-240 | sed 's/^/AUDITSTACK caddy log: /'
c(){ local host=$1 path=$2; shift 2; curl -sk -o /tmp/out -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host$path" --max-time 15 "$@"; }
for x in "api.example.test /health" "app.example.test /company" "app.example.test /restaurant" "api.example.test /company" "admin.example.test /admin" "app.example.test /admin" "api.example.test /api/v1/admin/review" "app.example.test /api/v1/admin/review" "admin.example.test /api/v1/admin/review" "api.example.test /.env"; do set -- $x; say "$1$2 -> $(c $1 $2)"; done
say "headers: $(curl -skI --resolve app.example.test:443:127.0.0.1 https://app.example.test/company | grep -iE 'content-security|strict-transport|x-frame|^server' | tr -d '\r' | cut -c1-90 | tr '\n' '|')"
PHONE=+23324$(printf %07d $((RANDOM*30)))
J='Content-Type: application/json'
say "register: $(c api.example.test /api/v1/auth/register -X POST -H "$J" -d "{\"phone\":\"$PHONE\",\"password\":\"mango river lantern\",\"kind\":\"customer\"}") $(cut -c1-120 /tmp/out)"
say "login: $(c api.example.test /api/v1/auth/login -X POST -H "$J" -d "{\"phone\":\"$PHONE\",\"password\":\"mango river lantern\"}")"
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/out')).get('token',''))")
say "me: $(c api.example.test /api/v1/me -H "Authorization: Bearer $TOKEN")"
say "search: $(c api.example.test '/api/v1/maps/search?q=Accra' -H "Authorization: Bearer $TOKEN")"
for i in $(seq 1 12); do c api.example.test /api/v1/auth/login -X POST -H "$J" -d "{\"phone\":\"$PHONE\",\"password\":\"wrong password here\"}" >/dev/null; done
say "wrong passwords then: $(c api.example.test /api/v1/auth/login -X POST -H "$J" -d "{\"phone\":\"$PHONE\",\"password\":\"mango river lantern\"}") $(cut -c1-100 /tmp/out)"
say "company policy: $(curl -sk -D - -o /dev/null --resolve app.example.test:443:127.0.0.1 https://app.example.test/company | grep -i content-security | cut -c1-120 | tr -d '\r')"
P3=+23255$(printf %07d $((RANDOM*30)))
P3=+23355$(printf %07d $((RANDOM*30)))
c api.example.test /api/v1/auth/register -X POST -H "$J" -d "{\"phone\":\"$P3\",\"password\":\"mango river lantern\",\"kind\":\"customer\"}" >/dev/null
for i in $(seq 1 12); do c api.example.test /api/v1/auth/login -X POST -H "$J" -H "X-Forwarded-For: 8.8.$i.$i" -d "{\"phone\":\"$P3\",\"password\":\"wrong password here\"}" >/dev/null; done
say "spoofed addresses then: $(c api.example.test /api/v1/auth/login -X POST -H "$J" -H 'X-Forwarded-For: 9.9.9.9' -d "{\"phone\":\"$P3\",\"password\":\"mango river lantern\"}") $(cut -c1-60 /tmp/out)"
docker compose restart api >/dev/null 2>&1; sleep 15
say "after restart: $(c api.example.test /api/v1/me -H "Authorization: Bearer $TOKEN") state $(docker compose ps api --format '{{.State}} {{.Health}}')"
# Limited database login, exactly as the security guide asks.
APPPW=auditapp$(openssl rand -hex 8)
echo "ELESEND_APP_DB_PASSWORD=$APPPW" >> .env
echo "DOCKER_APP_DATABASE_URL=postgres://elesend_app:$APPPW@db:5432/elesend" >> .env
docker compose run --rm migrate 2>&1 | tail -2 | sed 's/^/AUDITSTACK migrate with role: /'
docker compose up -d --no-deps --force-recreate api >/dev/null 2>&1; sleep 25
say "role api state: $(docker compose ps api --format '{{.State}} {{.Health}}')"
docker compose logs api --tail 6 2>&1 | cut -c1-260 | sed 's/^/AUDITSTACK role api log: /'
say "role me: $(c api.example.test /api/v1/me -H "Authorization: Bearer $TOKEN")"
P2=+23320$(printf %07d $((RANDOM*30)))
say "role register: $(c api.example.test /api/v1/auth/register -X POST -H "$J" -d "{\"phone\":\"$P2\",\"password\":\"mango river lantern\",\"kind\":\"rider\",\"vehicle\":\"motorcycle\",\"maxWeightG\":20000}") $(cut -c1-100 /tmp/out)"
sleep 70
docker compose logs api --since 90s 2>&1 | grep -iE 'error|warn|denied' | cut -c1-240 | sort | uniq -c | sort -rn | head -12 | sed 's/^/AUDITSTACK role jobs: /'
docker compose down -v >/dev/null 2>&1
exit 0
