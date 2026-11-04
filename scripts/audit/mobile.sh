#!/usr/bin/env bash
set +e
say(){ echo "AUDITMOBILE $*"; }
ROOT=$PWD
mkdir -p /tmp/lint && cd /tmp/lint && npm init -y >/dev/null && npm i --silent eslint@8 eslint-plugin-react@7 eslint-plugin-react-hooks@4 >/dev/null 2>&1
cat > .eslintrc.json <<'J'
{"root":true,"parserOptions":{"ecmaVersion":"latest","sourceType":"module","ecmaFeatures":{"jsx":true}},"env":{"es2022":true,"browser":true,"node":true},"plugins":["react","react-hooks"],
"rules":{"no-undef":"error","react/jsx-no-undef":"error","react/jsx-uses-vars":"error","react/jsx-uses-react":"error","react-hooks/rules-of-hooks":"error","no-dupe-keys":"error","no-unreachable":"error","no-const-assign":"error"}}
J
cp -r "$ROOT/apps/mobile/src" /tmp/lint/src
npx eslint --no-eslintrc -c .eslintrc.json --ext .js src 2>&1 | grep -vE '^$' | tail -40 | cut -c1-170 | sed 's/^/AUDITMOBILE lint: /'
cd "$ROOT/apps/mobile"
npm ci --ignore-scripts 2>&1 | tail -1 | cut -c1-140 | sed 's/^/AUDITMOBILE npm: /'
export EXPO_PUBLIC_ELESEND_API_BASE_URL=https://api.example.test CI=1
for v in customer rider; do
 EXPO_PUBLIC_ELESEND_APP_VARIANT=$v npx expo export --platform android --output-dir /tmp/out-$v 2>&1 | grep -E 'hbc|rror|Exported' | cut -c1-170 | sed "s/^/AUDITMOBILE export $v: /"
done
exit 0
