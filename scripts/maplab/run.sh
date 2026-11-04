#!/usr/bin/env bash
O=/tmp/out; mkdir -p $O; exec > >(tee $O/log.txt) 2>&1
mkdir -p /tmp/ml && cd /tmp/ml && npm pack --silent @maplibre/maplibre-react-native@10.4.2 >/dev/null && tar xzf *.tgz; grep -in "offline" package/src/MapLibreRN.ts; grep -n "export default\|export const\|export class" package/src/modules/offline/OfflineManager.ts; grep -n '"main"\|"types"' package/package.json; sed -n 84,92p package/src/modules/offline/OfflineManager.ts
