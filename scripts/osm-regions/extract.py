import csv,json,sys,collections,math
import osmium,shapely.wkb as sw
from shapely.strtree import STRtree
from shapely.geometry import Point
KEEP={'Greater Accra','Ashanti','Central','Eastern','Ahafo','Bono'}
wkb=osmium.geom.WKBFactory()
class R(osmium.SimpleHandler):
    def __init__(s):super().__init__();s.r=[]
    def area(s,a):
        if a.tags.get('admin_level')=='4' and a.tags.get('boundary')=='administrative' and a.tags.get('name'):
            try:s.r.append((a.tags['name'].replace(' Region','').strip(),sw.loads(wkb.create_multipolygon(a),hex=True)))
            except Exception:pass
r=R();r.apply_file(sys.argv[1],locations=True,idx='flex_mem');print('REGIONS',[n for n,_ in r.r])
names=[n for n,_ in r.r];tree=STRtree([g for _,g in r.r])
def region(lng,lat):
    p=Point(lng,lat)
    for i in tree.query(p):
        if r.r[int(i)][1].contains(p):return names[int(i)]
PL={'city':('settlement','city',95),'town':('settlement','town',85),'village':('settlement','village',65),'suburb':('settlement','suburb',70),'neighbourhood':('settlement','neighbourhood',55),'hamlet':('settlement','hamlet',45),'quarter':('settlement','quarter',55)}
AM={'hospital':('health','hospital',85),'clinic':('health','clinic',70),'doctors':('health','clinic',55),'pharmacy':('health','pharmacy',55),'school':('education','school',65),'college':('education','college',70),'university':('education','university',85),'marketplace':('market','market',80),'bus_station':('transport','station',75),'fuel':('commerce','fuel',60),'bank':('commerce','bank',60),'police':('landmark','police',70),'place_of_worship':('religion','worship',55),'restaurant':('commerce','restaurant',55),'fast_food':('commerce','restaurant',50),'townhall':('landmark','government',65),'post_office':('landmark','post_office',60)}
def kind(t):
    p=t.get('place')
    if p in PL:return PL[p]
    a=t.get('amenity')
    if a in AM:return AM[a]
    if t.get('tourism') in('hotel','guest_house'):return ('commerce','hotel',60)
    if t.get('shop') and t.get('shop') in('supermarket','mall'):return ('commerce',t['shop'],60)
    if t.get('junction') or t.get('highway')=='bus_stop':return ('transport','stop',50)
class P(osmium.SimpleHandler):
    def __init__(s):super().__init__();s.o=[]
    def add(s,t,i,lat,lng):
        n=t.get('name','').strip();k=kind(t)
        if len(n)<3 or not k:return
        rg=region(lng,lat)
        if not rg or rg in KEEP:return
        al=[t[x] for x in('alt_name','old_name','short_name','loc_name') if t.get(x)]
        s.o.append(dict(id=i,name=n,cat=k[0],sub=k[1],pop=k[2],region=rg,lat=lat,lng=lng,al=al,street=t.get('addr:street','')))
    def node(s,n):
        if 'name' in n.tags:s.add({t.k:t.v for t in n.tags},f'OSM_node_{n.id}',n.location.lat,n.location.lon)
    def way(s,w):
        if 'name' in w.tags:
            try:
                ps=[(x.location.lat,x.location.lon) for x in w.nodes];s.add({t.k:t.v for t in w.tags},f'OSM_way_{w.id}',sum(p[0] for p in ps)/len(ps),sum(p[1] for p in ps)/len(ps))
            except Exception:pass
p=P();p.apply_file(sys.argv[1],locations=True,idx='flex_mem')
towns=[x for x in p.o if x['cat']=='settlement' and x['sub'] in('city','town','village','suburb')]
grid=collections.defaultdict(list)
for t in towns:grid[(round(t['lat']*10),round(t['lng']*10))].append(t)
def near(x):
    best=None;bd=1e9
    a,b=round(x['lat']*10),round(x['lng']*10)
    for i in range(a-2,a+3):
        for j in range(b-2,b+3):
            for t in grid[(i,j)]:
                d=(t['lat']-x['lat'])**2+((t['lng']-x['lng'])*0.98)**2
                if d<bd:bd,best=d,t
    return best['name'] if best else x['region']
now='2026-11-06 00:00:00+00';seen=set();rows=[]
for x in p.o:
    k=(x['name'].lower(),round(x['lat'],3),round(x['lng'],3))
    if k in seen:continue
    seen.add(k);town=x['name'] if x['cat']=='settlement' else near(x)
    la,ln=f"{x['lat']:.6f}",f"{x['lng']:.6f}"
    rows.append([x['id'],x['name'],f"{x['name']} {town} {x['region']}".lower(),x['cat'],x['sub'],x['region'],town,town,la,ln,f'SRID=4326;POINT({ln} {la})','mapped_point','OpenStreetMap',x['id'],'source_coordinates_not_field_verified',json.dumps(x['al'],ensure_ascii=False),'\\N',str(x['pop']),x['street'] or '\\N',now,now])
rows.sort(key=lambda r:(r[5],-int(r[17]),r[1]))
csv.writer(open('data/spatial_landmarks_osm_regions.tsv','w',encoding='utf8',newline=''),delimiter='\t',lineterminator='\n').writerows(rows)
print('ROWS',len(rows),collections.Counter(r[5] for r in rows).most_common(),collections.Counter(r[3] for r in rows).most_common())
