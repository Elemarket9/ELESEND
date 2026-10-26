import React,{forwardRef,useId,useImperativeHandle,useMemo,useRef} from 'react';
import {View,Text,Platform,Linking} from 'react-native';
import {MapView as NativeMap,Camera,MarkerView,ShapeSource,CircleLayer,LineLayer} from '@maplibre/maplibre-react-native';
import {privateTileUrl,privateMapStyle,OSM_ATTRIBUTION} from './private-map-style.mjs';
import {VECTOR_TILE_URL, GLYPHS_URL, isDevelopmentEnvironment} from '../config.js';

let tileUrl=null;
try{
 tileUrl=VECTOR_TILE_URL ? privateTileUrl(VECTOR_TILE_URL,{development:isDevelopmentEnvironment()}):null;
}catch(e){
 tileUrl=null;
}
const glyphsUrl=GLYPHS_URL||(tileUrl?tileUrl.replace(/\/tiles\/.+$/,'/fonts/{fontstack}/{range}.pbf'):null);
const mapStyle=privateMapStyle(tileUrl,{glyphsUrl});
const coordinate=p=>[p.longitude,p.latitude];

export const MAP_RENDERER='elesend-private';
export const MAP_TRAFFIC_SUPPORTED=false;

function regionFromEvent(event){
 const props=event?.properties||{};
 const bounds=props.visibleBounds||props.bounds||null;
 const zoom=Number.isFinite(props.zoomLevel)?props.zoomLevel:Number.isFinite(props.zoom)?props.zoom:null;
 const center=Array.isArray(event?.geometry?.coordinates)?event.geometry.coordinates:null;
 return {zoom,bounds,center,isUserInteraction:props.isUserInteraction===true};
}

export default forwardRef(function MapView({initialRegion,children,onPress,onMapReady,onPanDrag,onRegionDidChange,style,accessibilityLabel},ref){
 const camera=useRef(null);
 const initial=useMemo(()=>({centerCoordinate:coordinate(initialRegion),zoomLevel:Math.max(1,Math.min(20,Math.log2(360/initialRegion.longitudeDelta)))}),[]);
 useImperativeHandle(ref,()=>({
  animateCamera({center,zoom},{duration=600}={}){camera.current?.setCamera({centerCoordinate:coordinate(center),zoomLevel:zoom,animationDuration:duration,animationMode:'easeTo'});},
  animateToRegion(region,duration=600){camera.current?.setCamera({centerCoordinate:coordinate(region),zoomLevel:Math.max(1,Math.min(20,Math.log2(360/region.longitudeDelta))),animationDuration:duration,animationMode:'easeTo'});},
  fitToCoordinates(points,{edgePadding={},animated=true}={}){
   if(!points?.length)return;
   const lons=points.map(p=>p.longitude),lats=points.map(p=>p.latitude);
   camera.current?.fitBounds([Math.max(...lons),Math.max(...lats)],[Math.min(...lons),Math.min(...lats)],[edgePadding.top??40,edgePadding.right??40,edgePadding.bottom??40,edgePadding.left??40],animated?600:0);
  }
 }),[]);
 return <View style={[style,{overflow:'hidden'}]} collapsable={false} accessibilityLabel={accessibilityLabel}>
  <NativeMap style={{flex:1}} mapStyle={mapStyle} attributionEnabled logoEnabled={false} compassEnabled
   onDidFinishLoadingMap={onMapReady}
   onRegionWillChange={event=>{if(event?.properties?.isUserInteraction)onPanDrag?.();}}
   onRegionDidChange={event=>{if(onRegionDidChange)onRegionDidChange(regionFromEvent(event));}}
   onPress={event=>{const c=event?.geometry?.coordinates;if(Array.isArray(c)&&c.length>=2)onPress?.({nativeEvent:{coordinate:{longitude:c[0],latitude:c[1]}}});}}>
   <Camera ref={camera} defaultSettings={initial}/>{children}
  </NativeMap>
  <Text style={{position:'absolute',bottom:4,left:4,fontSize:10,color:'#203e36',backgroundColor:'#ffffffdd'}}>{OSM_ATTRIBUTION}</Text>
  {!tileUrl&&<View pointerEvents="none" style={{position:'absolute',top:8,left:8,right:8,backgroundColor:'#fff8e5',padding:8}}><Text>Private Ghana map server is not configured. Map background is unavailable.</Text></View>}
 </View>;
});

export function Marker({coordinate:point,children,title,pinColor='#14695b',anchor={x:0.5,y:1}}){
 const id=useId();
 if(!point||!Number.isFinite(Number(point.latitude))||!Number.isFinite(Number(point.longitude)))return null;
 return <MarkerView id={id} coordinate={coordinate(point)} anchor={anchor}>
  <View collapsable={false} accessibilityLabel={title} style={{alignItems:'center'}}>
   {children??(
    <View style={{alignItems:'center'}}>
     {title?<View style={{backgroundColor:pinColor,paddingHorizontal:8,paddingVertical:3,borderRadius:8,marginBottom:2}}><Text style={{color:'#ffffff',fontSize:11,fontWeight:'700'}}>{title}</Text></View>:null}
     <View style={{width:18,height:18,borderRadius:9,backgroundColor:pinColor,borderWidth:3,borderColor:'white'}}/>
    </View>
   )}
  </View>
 </MarkerView>;
}

export function LandmarkLayer({features,onPress}){
 const id=useId().replace(/:/g,'');
 if(!features?.length)return null;
 const shape={type:'FeatureCollection',features:features.filter(feature=>Number.isFinite(feature?.latitude)&&Number.isFinite(feature?.longitude)).map(feature=>({
  type:'Feature',
  properties:{id:feature.id,name:feature.name||'',kind:feature.kind||'place',count:feature.count||1,city:feature.city||''},
  geometry:{type:'Point',coordinates:[feature.longitude,feature.latitude]}
 }))};
 if(!shape.features.length)return null;
 return <ShapeSource id={'landmarks-'+id} shape={shape} onPress={event=>{
  const feature=event?.features?.[0]||event?.nativeEvent?.features?.[0];
  const coords=feature?.geometry?.coordinates;
  if(!feature?.properties||!Array.isArray(coords))return;
  onPress?.({...feature.properties,longitude:coords[0],latitude:coords[1]});
 }}>
  <CircleLayer id={'landmarks-circle-'+id} style={{
   circleRadius:['case',['==',['get','kind'],'cluster'],14,5],
   circleColor:['case',['==',['get','kind'],'cluster'],'#0f766e','#526b64'],
   circleOpacity:0.9,
   circleStrokeWidth:1.5,
   circleStrokeColor:'#ffffff'
  }}/>
 </ShapeSource>;
}

export function RiderMarker({coordinate:point,heading=0,vehicle='motorcycle',title='Courier'}){
 const id=useId();
 return <MarkerView id={id} coordinate={coordinate(point)} anchor={{x:0.5,y:0.5}}>
  <View style={{alignItems:'center',justifyContent:'center'}} collapsable={false} accessibilityLabel={title}>
   <View style={{width:34,height:34,borderRadius:17,backgroundColor:'#172239',borderWidth:2,borderColor:'#3fd6b3',alignItems:'center',justifyContent:'center',transform:[{rotate:`${heading}deg`}],shadowColor:'#000',shadowOffset:{width:0,height:2},shadowOpacity:0.4,shadowRadius:4,elevation:5}}>
    <Text style={{fontSize:16}}>{vehicle==='car'?'🚗':'🛵'}</Text>
   </View>
   <View style={{position:'absolute',top:-3,width:6,height:6,borderRadius:3,backgroundColor:'#3fd6b3'}}/>
  </View>
 </MarkerView>;
}

export function CurrentLocationMarker({coordinate:point,accuracy=12,title='My Current Location'}){
 const id=useId();
 const haloSize=Math.min(90,Math.max(32,Math.round(accuracy*1.4)));
 return <MarkerView id={id} coordinate={coordinate(point)} anchor={{x:0.5,y:0.5}}>
  <View style={{alignItems:'center',justifyContent:'center'}} collapsable={false} accessibilityLabel={title}>
   <View style={{width:haloSize,height:haloSize,borderRadius:haloSize/2,backgroundColor:'rgba(56,189,248,0.22)',borderWidth:1.5,borderColor:'rgba(56,189,248,0.5)',alignItems:'center',justifyContent:'center'}}>
    <View style={{width:16,height:16,borderRadius:8,backgroundColor:'#0284C7',borderWidth:3,borderColor:'#FFFFFF',shadowColor:'#000',shadowOffset:{width:0,height:2},shadowOpacity:0.3,shadowRadius:3,elevation:5}}/>
   </View>
  </View>
 </MarkerView>;
}

export function Polyline({coordinates,strokeColor='#14695b',strokeWidth=5}){
 const id=useId().replace(/:/g,'');
 return <ShapeSource id={'route-'+id} shape={{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coordinates.map(coordinate)}}}><LineLayer id={'line-'+id} style={{lineColor:strokeColor,lineWidth:strokeWidth,lineCap:'round',lineJoin:'round'}}/></ShapeSource>;
}

export function openTurnByTurnNavigation({latitude,longitude,label='Delivery Point'}){
 const lat=Number(latitude),lon=Number(longitude);
 const uri=Platform.OS==='android'?`geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`:`https://maps.google.com/?daddr=${lat},${lon}`;
 return Linking.openURL(uri).catch(()=>Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`));
}
