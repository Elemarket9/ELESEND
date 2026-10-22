#!/usr/bin/env python3
"""
Generate migration 029: V9 National Business Discovery, Commercial Expansion & Spatial Registry
Creates national_businesses table, spatial indexes, and searchable_landmarks_v9 view.
Inserts all 4,295 newly discovered businesses, branches, and commercial ways idempotently.
"""

import json
import os
import re

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_FILE = os.path.join(PROJECT_ROOT, 'services', 'api', 'infrastructure', 'maps', 'ghana-gazetteer-data.json')
MIGRATION_FILE = os.path.join(PROJECT_ROOT, 'database', 'migrations', '029_v9_national_business_and_spatial_expansion.sql')

def escape_sql(text):
    if text is None:
        return 'NULL'
    return "'" + str(text).replace("'", "''") + "'"

with open(DATA_FILE, 'r', encoding='utf-8') as f:
    data = json.load(f)

new_recs = [r for r in data if r.get('id', '').startswith(('BIZ_', 'OSM_way_'))]
print(f'Found {len(new_recs)} new records for national_businesses')

sql_lines = [
    "-- Migration 029: V9 National Business Discovery, Commercial Expansion & Spatial Registry",
    "CREATE EXTENSION IF NOT EXISTS postgis;",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    "",
    "CREATE TABLE IF NOT EXISTS national_businesses (",
    "  id text PRIMARY KEY,",
    "  name text NOT NULL,",
    "  search_name text NOT NULL,",
    "  category text NOT NULL,",
    "  subcategory text NOT NULL,",
    "  region text NOT NULL,",
    "  locality text NOT NULL,",
    "  city text NOT NULL,",
    "  street text,",
    "  latitude double precision NOT NULL CHECK(latitude BETWEEN 4.5 AND 11.5),",
    "  longitude double precision NOT NULL CHECK(longitude BETWEEN -3.5 AND 1.5),",
    "  geom geography(Point, 4326) NOT NULL,",
    "  coordinate_kind text NOT NULL DEFAULT 'mapped_point',",
    "  source text NOT NULL,",
    "  source_id text,",
    "  license text NOT NULL DEFAULT 'ODbL 1.0',",
    "  verification_status text NOT NULL DEFAULT 'source_verified',",
    "  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,",
    "  entrance jsonb,",
    "  popularity integer NOT NULL DEFAULT 50 CHECK(popularity BETWEEN 0 AND 100),",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    "",
    "CREATE INDEX IF NOT EXISTS national_businesses_geom_gix ON national_businesses USING gist(geom);",
    "CREATE INDEX IF NOT EXISTS national_businesses_trgm_idx ON national_businesses USING gin(search_name gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS national_businesses_name_trgm_idx ON national_businesses USING gin(name gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS national_businesses_region_idx ON national_businesses(region, category);",
    "CREATE INDEX IF NOT EXISTS national_businesses_locality_idx ON national_businesses(locality);",
    "",
    "CREATE OR REPLACE VIEW searchable_landmarks_v9 AS",
    "SELECT id, name, search_name, category, subcategory, region, locality, city, street,",
    "       latitude, longitude, geom, coordinate_kind, source, source_id, license,",
    "       verification_status, aliases, entrance, popularity, created_at, updated_at",
    "FROM spatial_landmarks",
    "UNION ALL",
    "SELECT id, name, search_name, category, subcategory, region, locality, city, street,",
    "       latitude, longitude, geom, coordinate_kind, source, source_id, license,",
    "       verification_status, aliases, entrance, popularity, created_at, updated_at",
    "FROM national_businesses;",
    "",
    "-- Seed authentic Ghanaian business branches and commercial locations"
]

BATCH_SIZE = 250
for i in range(0, len(new_recs), BATCH_SIZE):
    batch = new_recs[i:i + BATCH_SIZE]
    sql_lines.append("INSERT INTO national_businesses (")
    sql_lines.append("  id, name, search_name, category, subcategory, region, locality, city, street,")
    sql_lines.append("  latitude, longitude, geom, coordinate_kind, source, source_id, license,")
    sql_lines.append("  verification_status, aliases, entrance, popularity")
    sql_lines.append(") VALUES")
    
    val_rows = []
    for r in batch:
        rid = escape_sql(r['id'])
        name = escape_sql(r['name'])
        aliases = r.get('aliases', [])
        aliases_sql = escape_sql(json.dumps(aliases)) + "::jsonb"
        
        search_name = f"{r['name']} {r['locality']} {r['city']} {r['region']} {' '.join(aliases)}"
        search_name_clean = re.sub(r'[^a-zA-Z0-9\s]', ' ', search_name)
        search_name_clean = re.sub(r'\s+', ' ', search_name_clean).strip().lower()
        search_name_sql = escape_sql(search_name_clean)
        
        category = escape_sql(r.get('category', 'commerce'))
        subcategory = escape_sql(r.get('subcategory', 'general'))
        region = escape_sql(r.get('region', 'Greater Accra'))
        locality = escape_sql(r.get('locality', 'Accra'))
        city = escape_sql(r.get('city', 'Accra'))
        street = escape_sql(r.get('street'))
        lat = f"{float(r['latitude']):.6f}"
        lon = f"{float(r['longitude']):.6f}"
        geom_sql = f"ST_SetSRID(ST_MakePoint({lon}, {lat}), 4326)::geography"
        coord_kind = escape_sql(r.get('coordinate_kind', 'mapped_business_feature'))
        source = escape_sql(r.get('source', 'ELESEND V9 Expansion'))
        source_id = escape_sql(r.get('id', ''))
        license_sql = escape_sql('ODbL 1.0')
        ver_status = escape_sql('verified')
        entrance = r.get('entrance')
        entrance_sql = escape_sql(json.dumps(entrance)) + "::jsonb" if entrance else "NULL"
        pop = str(int(r.get('popularity', 60)))
        
        row_str = f"  ({rid}, {name}, {search_name_sql}, {category}, {subcategory}, {region}, {locality}, {city}, {street}, {lat}, {lon}, {geom_sql}, {coord_kind}, {source}, {source_id}, {license_sql}, {ver_status}, {aliases_sql}, {entrance_sql}, {pop})"
        val_rows.append(row_str)
        
    sql_lines.append(",\n".join(val_rows))
    sql_lines.append("ON CONFLICT (id) DO NOTHING;\n")

with open(MIGRATION_FILE, 'w', encoding='utf-8') as f:
    f.write("\n".join(sql_lines) + "\n")

print(f'Successfully wrote migration 029 with {len(new_recs)} records to {MIGRATION_FILE}')
