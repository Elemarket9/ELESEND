#!/usr/bin/env bash
set +e
R=$PWD
mkdir -p /tmp/screens /tmp/ui && cd /tmp/ui && npm init -y >/dev/null
npm i --silent react@19.1.0 react-dom@19.1.0 react-native-web@0.21.1 esbuild@0.25 playwright@1.48 >/dev/null 2>&1
npx playwright install --with-deps chromium >/dev/null 2>&1
ln -sfn /tmp/ui/node_modules "$R/apps/node_modules"
cd /tmp/ui && NODE_PATH=/tmp/ui/node_modules ROOT="$R" node "$R/scripts/ui/build.cjs" 2>&1 | tail -15
NODE_PATH=/tmp/ui/node_modules ROOT="$R" node "$R/scripts/ui/shots.cjs" 2>&1 | tail -30
ls /tmp/screens | wc -l
cd "$R" && node --input-type=module -e "import('./services/api/admin-web/admin-portal.mjs').then(m=>require('fs').writeFileSync('/tmp/ui/admin.html',m.renderAdminPortalHtml()))" 2>&1 | tail -2
node -e "import('$R/services/api/admin-web/admin-portal.mjs').then(m=>require('fs').writeFileSync('/tmp/ui/admin.html',m.renderAdminPortalHtml()))"
cd /tmp/ui && NODE_PATH=/tmp/ui/node_modules ROOT="$R" node "$R/scripts/ui/web.cjs" 2>&1 | tee /tmp/screens/web-report.txt | tail -20
