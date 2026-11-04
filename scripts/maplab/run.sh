#!/usr/bin/env bash
set +e
R=$PWD; D=$HOME/ghana-map-data; O=/tmp/out; mkdir -p $O $D; exec > >(tee $O/log.txt) 2>&1
IMG=ghcr.io/project-osrm/osrm-backend:v26.4.0
npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
sh scripts/download-ghana.sh $D >/dev/null; docker pull -q $IMG
# 2. rider roads: base graph, then a made-up test road off the end of a real one
sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -1
docker run -d --name moto0 -p 5001:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm; sleep 15
npm_cfg=1 ROOT=$R node --input-type=module -e "
import {riderRoadsOsm,osrmNearest} from '$R/scripts/export-rider-roads.mjs';import fs from 'node:fs';
const start=(await (await fetch('http://127.0.0.1:5001/nearest/v1/driving/-0.1880,5.6130')).json()).waypoints[0].location;
const c=[start,[start[0]+0.0015,start[1]+0.0012],[start[0]+0.003,start[1]+0.0024]];console.log('test road',JSON.stringify(c));
const {osm,count}=await riderRoadsOsm([{name:'Rider Test Lane',allowedVehicles:['motorcycle'],coordinates:c}],osrmNearest('http://127.0.0.1:5001'));
fs.writeFileSync('/tmp/rr.osm',osm);fs.writeFileSync('/tmp/rr.json',JSON.stringify(c));console.log('ways',count);"
END=$(python3 -c "import json;c=json.load(open('/tmp/rr.json'));print(f'{c[2][0]},{c[2][1]}')")
curl -s "http://127.0.0.1:5001/nearest/v1/driving/$END" | python3 -c "import json,sys;print('before merge, nearest road m',json.load(sys.stdin)['waypoints'][0]['distance'])"
docker rm -f moto0 >/dev/null
sh scripts/merge-rider-roads.sh $D /tmp/rr.osm 2>&1 | tail -2
rm -f $D/ghana-latest.osrm* $D/ghana-motorcycle.osrm*
sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -1
docker run -d --name car -p 5000:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-latest.osrm
docker run -d --name moto -p 5001:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm; sleep 15
curl -s "http://127.0.0.1:5001/nearest/v1/driving/$END" | python3 -c "import json,sys;w=json.load(sys.stdin)['waypoints'][0];print('after merge, nearest road m',w['distance'],w['name'])"
curl -s "http://127.0.0.1:5001/route/v1/driving/-0.1825,5.5560;$END?overview=false" | python3 -c "import json,sys;r=json.load(sys.stdin);print('route to rider road',r['code'],r['routes'][0]['distance'] if r.get('routes') else '')"
curl -s "http://127.0.0.1:5000/route/v1/driving/-0.1825,5.5560;$END?overview=false" | python3 -c "import json,sys;r=json.load(sys.stdin);print('car (should stop short)',r['code'],r['waypoints'][1]['distance'] if r.get('waypoints') else '')"
# 3. real adapter: traffic flow against the real graph
node scripts/maplab/traffic.mjs
node scripts/maplab/routes.mjs 2>&1 | head -8
