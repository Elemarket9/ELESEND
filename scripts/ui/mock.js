export default new Proxy(function(){},{get:(t,k)=>k==='__esModule'?true:()=>Promise.resolve({})});
export const isTaskDefined=()=>false,defineTask=()=>{},hasStartedLocationUpdatesAsync=async()=>false,startLocationUpdatesAsync=async()=>{},stopLocationUpdatesAsync=async()=>{};
export const requestForegroundPermissionsAsync=async()=>({status:'granted',granted:true}),requestBackgroundPermissionsAsync=async()=>({status:'denied'}),getForegroundPermissionsAsync=async()=>({status:'denied'}),getCurrentPositionAsync=async()=>({coords:{latitude:5.6,longitude:-0.18,accuracy:10}}),watchPositionAsync=async(o,cb)=>{setTimeout(()=>cb({coords:{latitude:5.5575,longitude:-0.1825,accuracy:8,heading:10,speed:0},timestamp:Date.now()}),100);return{remove(){}}},reverseGeocodeAsync=async()=>[],Accuracy={High:1,Balanced:2,BestForNavigation:3},hasServicesEnabledAsync=async()=>false;
export const getItemAsync=async k=>localStorage.getItem(k),setItemAsync=async(k,v)=>localStorage.setItem(k,v),deleteItemAsync=async k=>localStorage.removeItem(k);
export const randomUUID=()=>crypto.randomUUID();
export const getPermissionsAsync=async()=>({status:'denied'}),requestPermissionsAsync=async()=>({status:'denied'}),setNotificationHandler=()=>{},addNotificationReceivedListener=()=>({remove(){}}),addNotificationResponseReceivedListener=()=>({remove(){}});
export const registerRootComponent=()=>{};
export const OfflineManager={getPack:async()=>null,deletePack:async()=>{},createPack:async()=>{}};
export const speak=()=>{},stop=()=>{};
export const useKeepAwake=()=>{};

export const AudioModule={requestRecordingPermissionsAsync:async()=>({granted:true})},AudioQuality={LOW:32},IOSOutputFormat={MPEG4AAC:'aac '},setAudioModeAsync=async()=>{},useAudioPlayer=()=>({play(){},pause(){},seekTo(){}}),useAudioPlayerStatus=()=>({isLoaded:true}),useAudioRecorder=()=>({prepareToRecordAsync:async()=>{},record(){},stop:async()=>{},uri:'x'}),EncodingType={Base64:'base64'},readAsStringAsync=async()=>'';
