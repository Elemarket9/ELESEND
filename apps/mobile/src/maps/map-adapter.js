import React,{forwardRef,useId,useImperativeHandle,useMemo,useRef} from 'react';
import {View,Text,Platform,Linking} from 'react-native';
import {MapView as NativeMap,Camera,MarkerView,ShapeSource,LineLayer} from '@maplibre/maplibre-react-native';
import {privateTileUrl,privateMapStyle,OSM_ATTRIBUTION} from './private-map-style.mjs';

const tileUrl=privateTileUrl(process.env.EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL||'',{development:typeof __DEV__!=='undefined'&&__DEV__});
const glyphsUrl=process.env.EXPO_PUBLIC_ELESEND_GLYPHS_URL||(tileUrl?tileUrl.replace(/\/tiles\/.+$/,'/fonts/{fontstack}/{range}.pbf'):null);
const mapStyle=privateMapStyle(tileUrl,{glyphsUrl});
const coordinate=p=>[p.longitude,p.latitude];

export const MAP_RENDERER='elesend-private';
export const MAP_TRAFFIC_SUPPORTED=false;

export default forwardRef(function MapView({initialRegion,children,onPress,onMapReady,onPanDrag,style,accessibilityLabel},ref){
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
 return <View style={style} accessibilityLabel={accessibilityLabel}>
  <NativeMap style={{flex:1}} mapStyle={mapStyle} attributionEnabled logoEnabled={false} compassEnabled
   onDidFinishLoadingMap={onMapReady}
   onRegionWillChange={event=>{if(event?.properties?.isUserInteraction)onPanDrag?.();}}
   onPress={event=>{const c=event?.geometry?.coordinates;if(Array.isArray(c)&&c.length>=2)onPress?.({nativeEvent:{coordinate:{longitude:c[0],latitude:c[1]}}});}}>
   <Camera ref={camera} defaultSettings={initial}/>{children}
  </NativeMap>
  <Text style={{position:'absolute',bottom:4,left:4,fontSize:10,color:'#203e36',backgroundColor:'#ffffffdd'}}>{OSM_ATTRIBUTION}</Text>
  {!tileUrl&&<View pointerEvents="none" style={{position:'absolute',top:8,left:8,right:8,backgroundColor:'#fff8e5',padding:8}}><Text>Private Ghana map server is not configured. Map background is unavailable.</Text></View>}
 </View>;
});

export function Marker({coordinate:point,children,title,pinColor='#14695b',anchor={x:0.5,y:1}}){
 const id=useId();
 return <MarkerView id={id} coordinate={coordinate(point)} anchor={anchor}>
  <View collapsable={false} accessibilityLabel={title}>{children??<View style={{width:20,height:20,borderRadius:10,backgroundColor:pinColor,borderWidth:3,borderColor:'white'}}/>}</View>
 </MarkerView>;
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

export function Polyline({coordinates,strokeColor='#14695b',strokeWidth=5}){
 const id=useId().replace(/:/g,'');
 return <ShapeSource id={'route-'+id} shape={{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coordinates.map(coordinate)}}}><LineLayer id={'line-'+id} style={{lineColor:strokeColor,lineWidth:strokeWidth,lineCap:'round',lineJoin:'round'}}/></ShapeSource>;
}

export function openTurnByTurnNavigation({latitude,longitude,label='Delivery Point'}){
 const lat=Number(latitude),lon=Number(longitude);
 const uri=Platform.OS==='android'?`geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(label)})`:`https://maps.google.com/?daddr=${lat},${lon}`;
 return Linking.openURL(uri).catch(()=>Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`));
}
