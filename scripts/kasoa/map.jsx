import React,{forwardRef,useEffect,useImperativeHandle,useRef,Children} from 'react';
import {View} from 'react-native';
import {privateMapStyle} from '../../apps/mobile/src/maps/private-map-style.mjs';
const T=window.__TILES;
export const Marker=()=>null,RiderMarker=()=>null,Polyline=()=>null,openTurnByTurnNavigation=()=>{};
const flat=children=>{const out=[];Children.forEach(children,c=>{if(!c)return;if(c.type===React.Fragment)out.push(...flat(c.props.children));else out.push(c);});return out;};
export default forwardRef(function MapView({style,children,initialRegion,region,night},ref){
 const box=useRef(null),map=useRef(null),marks=useRef([]);
 useEffect(()=>{const c=(initialRegion||region||{latitude:5.55,longitude:-0.3});
  map.current=new window.maplibregl.Map({container:box.current,style:privateMapStyle(T.tiles,{glyphsUrl:T.glyphs,night}),center:[c.longitude,c.latitude],zoom:window.__ZOOM||13,attributionControl:false});window.__maps=(window.__maps||[]);window.__maps.push(map.current);return ()=>map.current?.remove();},[]);
 useImperativeHandle(ref,()=>({animateCamera:({center,zoom,pitch})=>{if(center)map.current?.jumpTo({center:[center.longitude,center.latitude],zoom:window.__ZOOM||zoom||15,pitch:pitch||0});},animateToRegion:r=>map.current?.jumpTo({center:[r.longitude,r.latitude]}),fitToCoordinates:pts=>{if(pts?.length>1){const b=new window.maplibregl.LngLatBounds();pts.forEach(p=>b.extend([p.longitude,p.latitude]));map.current?.fitBounds(b,{padding:60,duration:0});}}}));
 useEffect(()=>{const m=map.current;if(!m)return;const draw=()=>{marks.current.forEach(x=>x.remove());marks.current=[];let i=0;
   for(const c of flat(children)){if(c.type===Polyline&&c.props.coordinates?.length>1){const id='line'+(i++),data={type:'Feature',geometry:{type:'LineString',coordinates:c.props.coordinates.map(p=>[p.longitude,p.latitude])}};if(m.getSource(id))m.getSource(id).setData(data);else{m.addSource(id,{type:'geojson',data});m.addLayer({id,type:'line',source:id,paint:{'line-color':c.props.strokeColor||'#18C6A5','line-width':c.props.strokeWidth||6}});}}
    else if(c.props?.coordinate){marks.current.push(new window.maplibregl.Marker({color:c.type===RiderMarker?'#2563EB':(c.props.pinColor||'#FF5A36')}).setLngLat([c.props.coordinate.longitude,c.props.coordinate.latitude]).addTo(m));}}};
  if(m.isStyleLoaded())draw();else m.once('load',draw);});
 return <View style={[{overflow:'hidden'},style]}><div ref={box} style={{position:'absolute',inset:0}}/></View>;
});
