import { ghanaSearch } from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

const queries = [
  'ALS Shipping Logistics',
  'KAAF University',
  'KHAF University',
  'Central Mosque',
  'Pharmacy near Madina',
  'Shipping company in Kwabenya',
  'Restaurant in Sunyani',
  'Hospital near Kasoa',
  'Supermarket in Kumasi',
  'Filling station in Cape Coast',
  'Schools around Nsawam',
  'Market near Goaso'
];

for (const q of queries) {
  const res = ghanaSearch(q, { limit: 3 });
  console.log(`\n=== QUERY: "${q}" ===`);
  if (res.length === 0) {
    console.log('  -> [NO RESULTS]');
  } else {
    res.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name} [${r.category}] (${r.city}, ${r.region})`);
    });
  }
}
