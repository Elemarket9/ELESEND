#!/usr/bin/env bash
set +e
R=$PWD; D=$HOME/ghana-map-data; O=/tmp/out; mkdir -p $O $D; exec > >(tee $O/log.txt) 2>&1
sh scripts/download-ghana.sh $D; ls -la $D
sh scripts/build-ghana-tiles.sh $D 2>&1 | tail -25; ls -la $D/ghana.mbtiles
TK=$(curl -s "https://ghcr.io/token?scope=repository:project-osrm/osrm-backend:pull" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s -H "Authorization: Bearer $TK" "https://ghcr.io/v2/project-osrm/osrm-backend/tags/list?n=5000" > /tmp/tags.json
TAG=$(python3 -c "import json,re;t=[x for x in json.load(open('/tmp/tags.json'))['tags'] if re.fullmatch(r'v\d+\.\d+\.\d+',x)];t.sort(key=lambda x:[int(n) for n in x[1:].split('.')]);print(t[-1]);print(' '.join(t[-8:]),file=__import__('sys').stderr)")
echo "OSRM_TAG=$TAG"; docker pull -q ghcr.io/project-osrm/osrm-backend:$TAG
sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -25
cd /tmp && curl -fsSL -o fonts.zip https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip && mkdir -p f && cd f && unzip -q ../fonts.zip; ls | head -40
for n in "Noto Sans Regular" "Noto Sans Bold"; do mkdir -p "$R/services/maps/fonts/$n" "$O/fonts/$n"; for r in 0-255 256-511 512-767 8192-8447; do cp "$n/$r.pbf" "$R/services/maps/fonts/$n/" && cp "$n/$r.pbf" "$O/fonts/$n/"; done; done; du -sh $O/fonts
cd $R
docker run -d --name car -p 5000:5000 -v $D:/data ghcr.io/project-osrm/osrm-backend:$TAG osrm-routed --algorithm mld /data/ghana-latest.osrm
docker run -d --name moto -p 5001:5000 -v $D:/data ghcr.io/project-osrm/osrm-backend:$TAG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm
GHANA_MBTILES=$D/ghana.mbtiles MAP_PORT=3145 node services/maps/tile-server.mjs & sleep 25
docker logs moto 2>&1 | tail -3
curl -s -o /dev/null -w "font %{http_code} %{size_download}\n" "http://127.0.0.1:3145/fonts/Noto%20Sans%20Regular/0-255.pbf"
ls -la $D/ghana.mbtiles; du -sh $D/ghana.mbtiles
node scripts/maplab/routes.mjs | tee $O/routes.txt
mkdir -p /tmp/lab && cd /tmp/lab && npm init -y >/dev/null && npm i --silent maplibre-gl@4.7.1 playwright@1.48 >/dev/null 2>&1 && npx playwright install --with-deps chromium >/dev/null 2>&1
cd /tmp/lab && ROOT=$R node --input-type=commonjs -e "require('$R/scripts/maplab/render.cjs')"
