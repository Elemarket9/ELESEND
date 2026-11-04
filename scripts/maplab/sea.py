import osmium, sys, json
from shapely.geometry import LineString
class H(osmium.SimpleHandler):
    def __init__(s): super().__init__(); s.w=[]
    def way(s,w):
        if w.tags.get('natural')=='coastline':
            try: s.w.append([(n.lon,n.lat) for n in w.nodes])
            except Exception: pass
h=H(); h.apply_file(sys.argv[1],locations=True)
print('coast ways',len(h.w))
ends={}
for w in h.w: ends.setdefault(w[0],[]).append(w)
used=set(); chains=[]
heads=set(w[-1] for w in h.w)
for w in h.w:
    if w[0] in heads or id(w) in used: continue
    c=list(w); used.add(id(w))
    while c[-1] in ends:
        n=[x for x in ends[c[-1]] if id(x) not in used]
        if not n: break
        c+=n[0][1:]; used.add(id(n[0]))
    chains.append(c)
chains=[c for c in chains if len(c)>50]
print('chains',len(chains),[len(c) for c in chains][:10])
pts=[]
for c in sorted(chains,key=lambda c:min(p[0] for p in c)):
    if c[0][0]>c[-1][0]: c=c[::-1]
    pts+=c
line=LineString(pts).simplify(float(sys.argv[3]),preserve_topology=False)
co=[[round(x,5),round(y,5)] for x,y in line.coords]
W,E=-3.6,1.6
ring=[[W,co[0][1]]]+co+[[E,co[-1][1]],[E,3.0],[W,3.0],[W,co[0][1]]]
open(sys.argv[2],'w').write('// Generated from the OpenStreetMap Ghana coastline. © OpenStreetMap contributors\nexport const GHANA_SEA='+json.dumps(ring,separators=(',',':'))+';\n')
print('points',len(ring))
