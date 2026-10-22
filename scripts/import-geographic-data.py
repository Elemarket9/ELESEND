#!/usr/bin/env python3
"""
ELESEND Private Maps - Geographic POI Discovery and Ingestion Engine
Extracts authentic named POIs and communities strictly within:
  - Greater Accra Region (Comprehensive)
  - Central Region (Comprehensive)
  - Ashanti Region (Comprehensive)
  - Eastern Region (Selected populated hubs within 15 km)
  - Ahafo Region (Selected populated hubs within 15 km)
  - Bono Region (Sunyani and its surrounding communities within 18 km ONLY)
"""

import sys
import os
import csv
import json
import math
import re
import time
from collections import Counter
from shapely.geometry import shape, Point
from shapely.prepared import prep

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(DATA_DIR)
ADM1_FILE = os.path.join(PROJECT_ROOT, 'ghana-adm1.geojson')
GEONAMES_FILE = os.path.join(PROJECT_ROOT, 'geonames-gh', 'GH.txt')
USER_SEED_FILE = os.path.join(PROJECT_ROOT, 'data', 'ghana_community_landmarks_seed.csv')
OSM_PBF_FILE = r'C:\Users\sonofjacob\ghana-map-data\ghana-latest.osm.pbf'
OUTPUT_TSV = os.path.join(PROJECT_ROOT, 'data', 'spatial_landmarks_import.tsv')
OUTPUT_JSON = os.path.join(PROJECT_ROOT, 'services', 'api', 'infrastructure', 'maps', 'ghana-gazetteer-data.json')

# 1. Load Region Boundaries
print('[1/6] Loading administrative boundaries from geoBoundaries ADM1...')
with open(ADM1_FILE, 'r', encoding='utf-8') as f:
    gj = json.load(f)

regions = {}
for feat in gj['features']:
    name = feat['properties']['shapeName']
    regions[name] = prep(shape(feat['geometry']))

# Selected populated hubs for Eastern Region (15 km radius)
EASTERN_HUBS = [
    ('Koforidua', 6.0945, -0.2591),
    ('Nsawam', 5.8089, -0.3503),
    ('Suhum', 6.0406, -0.4508),
    ('Nkawkaw', 6.5512, -0.7667),
    ('Akim Oda', 5.9267, -0.9858),
    ('Somanya', 6.1065, -0.0152),
    ('Asamankese', 5.8601, -0.6635),
    ('Kibi', 6.1649, -0.5539),
    ('Aburi', 5.8483, -0.1764),
    ('Mampong-Akwapim', 5.9189, -0.1411),
    ('Akropong', 5.9744, -0.0894),
    ('Begoro', 6.3881, -0.3808),
    ('Donkorkrom', 6.9500, -0.0833),
    ('Kwabeng', 6.3134, -0.5878),
]

# Selected populated hubs for Ahafo Region (15 km radius)
AHAFO_HUBS = [
    ('Goaso', 6.8044, -2.5161),
    ('Bechem', 7.0894, -2.0250),
    ('Kenyasi', 6.9892, -2.3811),
    ('Duayaw Nkwanta', 7.1706, -2.0967),
    ('Mim', 6.9111, -2.5850),
    ('Hwidiem', 6.9400, -2.3700),
    ('Yamfo', 7.2333, -2.1833),
]

# Sunyani hub for Bono Region (18 km radius ONLY)
SUNYANI_HUB = (7.3399, -2.3268)

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def check_scope(lat, lon):
    if lat < 4.5 or lat > 11.5 or lon < -3.5 or lon > 1.5:
        return None, None
    pt = Point(lon, lat)
    # 1. Greater Accra (Comprehensive)
    if regions['Greater Accra Region'].contains(pt):
        return 'Greater Accra', 'Greater Accra'
    # 2. Central (Comprehensive)
    if regions['Central Region'].contains(pt):
        return 'Central', 'Central'
    # 3. Ashanti (Comprehensive)
    if regions['Ashanti Region'].contains(pt):
        return 'Ashanti', 'Ashanti'
    # 4. Eastern (Selected populated hubs within 15 km)
    if regions['Eastern Region'].contains(pt):
        for hname, hlat, hlon in EASTERN_HUBS:
            if haversine_km(lat, lon, hlat, hlon) <= 15.0:
                return 'Eastern', f'{hname} Area'
        return None, None
    # 5. Ahafo (Selected populated hubs within 15 km)
    if regions['Ahafo Region'].contains(pt):
        for hname, hlat, hlon in AHAFO_HUBS:
            if haversine_km(lat, lon, hlat, hlon) <= 15.0:
                return 'Ahafo', f'{hname} Area'
        return None, None
    # 6. Bono (Sunyani and its surrounding communities within 18 km ONLY)
    if regions['Bono Region'].contains(pt):
        if haversine_km(lat, lon, SUNYANI_HUB[0], SUNYANI_HUB[1]) <= 18.0:
            return 'Bono', 'Sunyani Metropolitan Area'
        return None, None
    return None, None

def normalize_text(text):
    if not text:
        return ''
    clean = re.sub(r'[^a-zA-Z0-9\s]', ' ', text)
    clean = re.sub(r'\s+', ' ', clean).strip().lower()
    return clean

# Landmark Repository Map keyed by (normalized_name, round(lat, 3), round(lon, 3))
landmarks = {}

def add_record(rec):
    lat = float(rec['latitude'])
    lon = float(rec['longitude'])
    region, community_hint = check_scope(lat, lon)
    if not region:
        return False

    name = rec['name'].strip()
    norm_name = normalize_text(name)
    if len(norm_name) < 2:
        return False

    # Proximity dedup key (~100m grid)
    grid_key = (norm_name, round(lat, 3), round(lon, 3))
    
    category = rec.get('category', 'landmark')
    subcategory = rec.get('subcategory', 'general')
    popularity = int(rec.get('popularity', 50))
    coordinate_kind = rec.get('coordinate_kind', 'mapped_point')
    verification_status = rec.get('verification_status', 'source_verified')
    license_type = rec.get('license', 'ODbL 1.0')
    source = rec.get('source', 'dataset')
    source_id = rec.get('source_id', rec.get('id', ''))
    locality = rec.get('locality', community_hint or region)
    city = rec.get('city', community_hint or region)
    aliases = rec.get('aliases', [])
    if isinstance(aliases, str):
        try:
            aliases = json.loads(aliases)
        except Exception:
            aliases = [a.strip() for a in aliases.split(';') if a.strip()]
    entrance = rec.get('entrance', None)
    if isinstance(entrance, str) and entrance:
        try:
            entrance = json.loads(entrance)
        except Exception:
            entrance = None

    search_name = f"{name} {locality} {city} {region} {' '.join(aliases)}".strip()
    search_name = normalize_text(search_name)

    entry = {
        'id': rec.get('id') or f"GEO_{len(landmarks)+1:06d}",
        'name': name,
        'search_name': search_name,
        'category': category,
        'subcategory': subcategory,
        'region': region,
        'locality': locality,
        'city': city,
        'latitude': lat,
        'longitude': lon,
        'coordinate_kind': coordinate_kind,
        'source': source,
        'source_id': str(source_id),
        'license': license_type,
        'verification_status': verification_status,
        'aliases': aliases,
        'entrance': entrance,
        'popularity': popularity
    }

    if grid_key in landmarks:
        existing = landmarks[grid_key]
        # Keep the one with higher popularity or entrance
        if entry['popularity'] > existing['popularity'] or entry['entrance']:
            entry['aliases'] = list(set(existing['aliases'] + entry['aliases']))
            landmarks[grid_key] = entry
        else:
            existing['aliases'] = list(set(existing['aliases'] + entry['aliases']))
    else:
        landmarks[grid_key] = entry
    return True

# 2. Ingest Seed User CSV Dataset
print('[2/6] Processing verified user dataset...')
if os.path.exists(USER_SEED_FILE):
    with open(USER_SEED_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        added_seed = 0
        for row in reader:
            if not row.get('latitude') or not row.get('longitude'):
                continue
            rec = {
                'id': row.get('id'),
                'name': row.get('name'),
                'category': row.get('category', 'landmark'),
                'subcategory': row.get('subcategory', 'general'),
                'region': row.get('region'),
                'locality': row.get('community_hint') or row.get('region'),
                'city': row.get('community_hint') or row.get('region'),
                'latitude': float(row['latitude']),
                'longitude': float(row['longitude']),
                'coordinate_kind': row.get('coordinate_kind', 'mapped_point'),
                'source': row.get('source', 'User seed sample'),
                'source_id': row.get('id'),
                'license': row.get('license', 'ODbL 1.0'),
                'verification_status': row.get('verification_status', 'source_verified'),
                'popularity': 75 if row.get('category') in ('education', 'health') else 65
            }
            if add_record(rec):
                added_seed += 1
        print(f'  -> Imported {added_seed} records from user seed CSV')

# 3. Ingest Core Institutions from ghana-geocoder.mjs (KAAF campuses, KNUST, UCC, Korle Bu, KATH, etc.)
print('[3/6] Processing core ELESEND gazetteer institutions...')
GEOCODER_FILE = os.path.join(PROJECT_ROOT, 'services', 'api', 'infrastructure', 'maps', 'ghana-geocoder.mjs')
if os.path.exists(GEOCODER_FILE):
    with open(GEOCODER_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    # Simple regex extraction of object literals in GHANA_GAZETTEER
    matches = re.findall(r"name:\s*'([^']+)',\s*category:\s*'([^']+)',\s*locality:\s*'([^']+)',\s*city:\s*'([^']+)',\s*region:\s*'([^']+)',\s*latitude:\s*([\d\.-]+),\s*longitude:\s*([\d\.-]+),\s*popularity:\s*(\d+)", content)
    added_core = 0
    for m in matches:
        name, cat, loc, city, reg, lat, lon, pop = m
        rec = {
            'id': f"CORE_{normalize_text(name)[:20].replace(' ', '_')}_{pop}",
            'name': name,
            'category': cat,
            'subcategory': 'tertiary' if cat == 'education' else 'institution',
            'region': reg,
            'locality': loc,
            'city': city,
            'latitude': float(lat),
            'longitude': float(lon),
            'coordinate_kind': 'entrance_point' if 'Campus' in name else 'mapped_point',
            'source': 'ELESEND Verified Gazetteer',
            'source_id': name,
            'license': 'Proprietary ELESEND Database',
            'verification_status': 'field_verified',
            'popularity': int(pop)
        }
        if add_record(rec):
            added_core += 1
    print(f'  -> Imported {added_core} core institutional landmarks')

# 4. Ingest GeoNames Populated Places & Facilities
print('[4/6] Processing GeoNames Ghana populated places and institutions...')
GEONAMES_CLASS_MAP = {
    'SCH': ('education', 'school', 60),
    'UNIV': ('education', 'university', 85),
    'COLL': ('education', 'college', 75),
    'HOSP': ('health', 'hospital', 80),
    'CLNK': ('health', 'clinic', 70),
    'PPL': ('settlement', 'locality', 65),
    'PPLA': ('settlement', 'regional_capital', 90),
    'PPLC': ('settlement', 'national_capital', 95),
    'PPLX': ('settlement', 'suburb', 60),
    'CH': ('religion', 'church', 50),
    'MSQE': ('religion', 'mosque', 50),
    'PRK': ('leisure', 'park', 55),
    'STDM': ('leisure', 'stadium', 70),
    'AIRP': ('transport', 'airport', 85),
    'PO': ('public_service', 'post_office', 60),
    'POL': ('public_service', 'police', 65),
    'BDG': ('public_service', 'building', 50),
}

if os.path.exists(GEONAMES_FILE):
    geonames_added = 0
    with open(GEONAMES_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            parts = line.strip().split('\t')
            if len(parts) < 10:
                continue
            gid = parts[0]
            name = parts[1]
            altnames = parts[3].split(',') if parts[3] else []
            lat = float(parts[4])
            lon = float(parts[5])
            fclass = parts[6]
            fcode = parts[7]

            if fclass not in ('P', 'S', 'L'):
                continue

            cat_info = GEONAMES_CLASS_MAP.get(fcode, ('settlement' if fclass == 'P' else 'landmark', fcode.lower(), 50))
            category, subcategory, popularity = cat_info

            rec = {
                'id': f"GN_{gid}",
                'name': name,
                'category': category,
                'subcategory': subcategory,
                'latitude': lat,
                'longitude': lon,
                'coordinate_kind': 'community_reference_point' if fclass == 'P' else 'mapped_point',
                'source': 'GeoNames Ghana',
                'source_id': gid,
                'license': 'CC BY 4.0',
                'verification_status': 'geonames_verified',
                'aliases': [a.strip() for a in altnames[:5] if a.strip() and a.strip() != name],
                'popularity': popularity
            }
            if add_record(rec):
                geonames_added += 1
    print(f'  -> Imported {geonames_added} records from GeoNames within target regions')

# 5. Ingest OpenStreetMap PBF Named Amenities & Communities
print('[5/6] Processing OpenStreetMap named nodes from ghana-latest.osm.pbf...')
OSM_AMENITY_MAP = {
    'school': ('education', 'school', 60),
    'university': ('education', 'university', 85),
    'college': ('education', 'college', 75),
    'kindergarten': ('education', 'kindergarten', 55),
    'hospital': ('health', 'hospital', 85),
    'clinic': ('health', 'clinic', 70),
    'pharmacy': ('health', 'pharmacy', 60),
    'doctors': ('health', 'clinic', 60),
    'place_of_worship': ('religion', 'worship', 55),
    'fuel': ('commerce', 'fuel_station', 70),
    'marketplace': ('commerce', 'market', 80),
    'bank': ('commerce', 'bank', 65),
    'police': ('public_service', 'police', 70),
    'post_office': ('public_service', 'post_office', 60),
    'townhall': ('public_service', 'government', 65),
    'bus_station': ('transport', 'bus_station', 75),
    'taxi': ('transport', 'taxi_rank', 70),
    'restaurant': ('commerce', 'restaurant', 65),
    'fast_food': ('commerce', 'fast_food', 60),
    'cafe': ('commerce', 'cafe', 55),
}

if os.path.exists(OSM_PBF_FILE):
    import osmium
    class OSMNodeImporter(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.added = 0
        def node(self, n):
            loc = n.location
            if not loc.valid():
                return
            lat, lon = loc.lat, loc.lon
            # Fast envelope check for target regions: lat 5.0 to 7.7, lon -2.8 to 0.35
            if lat < 5.0 or lat > 7.7 or lon < -2.8 or lon > 0.35:
                return
            if not n.tags:
                return
            name = n.tags.get('name')
            if not name:
                return

            cat, subcat, pop = None, None, 50
            amenity = n.tags.get('amenity')
            place = n.tags.get('place')
            shop = n.tags.get('shop')
            highway = n.tags.get('highway')
            leisure = n.tags.get('leisure')
            tourism = n.tags.get('tourism')

            if amenity in OSM_AMENITY_MAP:
                cat, subcat, pop = OSM_AMENITY_MAP[amenity]
            elif place in ('city', 'town', 'suburb', 'neighbourhood', 'village', 'hamlet'):
                cat = 'settlement'
                subcat = place
                pop = 80 if place in ('city', 'town') else 60
            elif shop:
                cat = 'commerce'
                subcat = f'shop_{shop}'
                pop = 60
            elif highway in ('bus_stop', 'traffic_signals', 'motorway_junction'):
                cat = 'transport'
                subcat = highway
                pop = 55
            elif leisure in ('park', 'sports_centre', 'stadium'):
                cat = 'leisure'
                subcat = leisure
                pop = 60
            elif tourism in ('hotel', 'guest_house', 'attraction'):
                cat = 'commerce'
                subcat = tourism
                pop = 65
            else:
                cat = 'landmark'
                subcat = 'general'
                pop = 50

            rec = {
                'id': f"OSM_node_{n.id}",
                'name': name,
                'category': cat,
                'subcategory': subcat,
                'latitude': lat,
                'longitude': lon,
                'coordinate_kind': 'mapped_point',
                'source': 'OpenStreetMap',
                'source_id': str(n.id),
                'license': 'ODbL 1.0',
                'verification_status': 'osm_community_verified',
                'popularity': pop
            }
            if add_record(rec):
                self.added += 1

    handler = OSMNodeImporter()
    t0 = time.time()
    handler.apply_file(OSM_PBF_FILE, locations=False)
    t1 = time.time()
    print(f'  -> Imported {handler.added} records from OpenStreetMap PBF in {t1-t0:.1f}s')

# 6. Summary and Export to TSV & JSON
total_unique = len(landmarks)
print(f'[6/6] Writing {total_unique} unique production landmarks...')

region_counts = Counter(e['region'] for e in landmarks.values())
cat_counts = Counter(e['category'] for e in landmarks.values())

print('\n' + '='*50)
print('ELESEND PRODUCTION GEOGRAPHIC REPOSITORY SUMMARY')
print('='*50)
print(f'Total Unique Searchable Landmarks: {total_unique}')
print('\nBreakdown by Region (Strict 6 Regions Enforced):')
for reg, cnt in region_counts.most_common():
    print(f'  - {reg}: {cnt} records')

print('\nBreakdown by Category:')
for cat, cnt in cat_counts.most_common():
    print(f'  - {cat}: {cnt} records')

# Write TSV for PostgreSQL COPY
with open(OUTPUT_TSV, 'w', encoding='utf-8', newline='') as f:
    writer = csv.writer(f, delimiter='\t')
    for e in landmarks.values():
        writer.writerow([
            e['id'],
            e['name'],
            e['search_name'],
            e['category'],
            e['subcategory'],
            e['region'],
            e['locality'],
            e['city'],
            f"{e['latitude']:.6f}",
            f"{e['longitude']:.6f}",
            f"SRID=4326;POINT({e['longitude']:.6f} {e['latitude']:.6f})",
            e['coordinate_kind'],
            e['source'],
            e['source_id'],
            e['license'],
            e['verification_status'],
            json.dumps(e['aliases']),
            json.dumps(e['entrance']) if e['entrance'] else '\\N',
            e['popularity'],
            'NOW()',
            'NOW()'
        ])

print(f'\nWrote PostgreSQL TSV import file to: {OUTPUT_TSV}')

# Write compact JSON file for fast in-memory gazetteer / cache
compact_records = []
for e in sorted(landmarks.values(), key=lambda x: -x['popularity']):
    compact_records.append({
        'name': e['name'],
        'category': e['category'],
        'locality': e['locality'],
        'city': e['city'],
        'region': e['region'],
        'latitude': round(e['latitude'], 6),
        'longitude': round(e['longitude'], 6),
        'popularity': e['popularity'],
        'aliases': e['aliases'],
        'entrance': e['entrance']
    })

with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(compact_records, f, separators=(',', ':'))

print(f'Wrote compact in-memory gazetteer ({len(compact_records)} records) to: {OUTPUT_JSON}')
print('Ingestion preparation completed successfully!')
