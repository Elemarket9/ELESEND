import json
import csv

with open('services/api/infrastructure/maps/ghana-gazetteer-data.json', 'r', encoding='utf-8') as f:
    items = json.load(f)

with open('data/spatial_landmarks_import.tsv', 'w', encoding='utf-8', newline='') as f:
    writer = csv.writer(f, delimiter='\t')
    for idx, e in enumerate(items, 1):
        uid = f"GEO_{idx:06d}"
        name = e['name']
        aliases = e.get('aliases') or []
        locality = e.get('locality') or e['region']
        city = e.get('city') or e['region']
        region = e['region']
        search_terms = f"{name} {locality} {city} {region} {' '.join(aliases)}".lower()
        search_name = ''.join(c if c.isalnum() or c.isspace() else ' ' for c in search_terms)
        search_name = ' '.join(search_name.split())
        
        writer.writerow([
            uid,
            name,
            search_name,
            e['category'],
            'general',
            region,
            locality,
            city,
            f"{e['latitude']:.6f}",
            f"{e['longitude']:.6f}",
            f"SRID=4326;POINT({e['longitude']:.6f} {e['latitude']:.6f})",
            'entrance_point' if e.get('entrance') else 'mapped_point',
            'ELESEND Spatial Ingestion',
            str(idx),
            'ODbL 1.0 / CC BY 4.0',
            'verified',
            json.dumps(aliases),
            json.dumps(e['entrance']) if e.get('entrance') else '\\N',
            e.get('popularity', 50),
            'NOW()',
            'NOW()'
        ])

print(f"Successfully generated {len(items)} sanitized records to TSV")
