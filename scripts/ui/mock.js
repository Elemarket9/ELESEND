export default new Proxy(function(){},{get:(t,k)=>k==='__esModule'?true:()=>Promise.resolve({})});
export const isTaskDefined=()=>false,defineTask=()=>{},hasStartedLocationUpdatesAsync=async()=>false,startLocationUpdatesAsync=async()=>{},stopLocationUpdatesAsync=async()=>{};
export const requestForegroundPermissionsAsync=async()=>({status:'denied',granted:false}),requestBackgroundPermissionsAsync=async()=>({status:'denied'}),getForegroundPermissionsAsync=async()=>({status:'denied'}),getCurrentPositionAsync=async()=>({coords:{latitude:5.6,longitude:-0.18,accuracy:10}}),watchPositionAsync=async()=>({remove(){}}),reverseGeocodeAsync=async()=>[],Accuracy={High:1,Balanced:2,BestForNavigation:3},hasServicesEnabledAsync=async()=>false;
export const getItemAsync=async k=>localStorage.getItem(k),setItemAsync=async(k,v)=>localStorage.setItem(k,v),deleteItemAsync=async k=>localStorage.removeItem(k);
export const randomUUID=()=>crypto.randomUUID();
export const getPermissionsAsync=async()=>({status:'denied'}),requestPermissionsAsync=async()=>({status:'denied'}),setNotificationHandler=()=>{},addNotificationReceivedListener=()=>({remove(){}}),addNotificationResponseReceivedListener=()=>({remove(){}});
export const registerRootComponent=()=>{};
