// Client-side Google Maps SDK keys are restricted by application package/signing identity.
// NEVER use the server-side Google Routes key in mobile builds.
export default ({config})=>({
 ...config,
 android:{...config.android,config:{...config.android?.config,googleMaps:{apiKey:process.env.GOOGLE_ANDROID_MAPS_SDK_KEY||'CONFIGURE_GOOGLE_ANDROID_MAPS_SDK_KEY'}}},
 ios:{...config.ios,config:{...config.ios?.config,googleMapsApiKey:process.env.GOOGLE_IOS_MAPS_SDK_KEY||'CONFIGURE_GOOGLE_IOS_MAPS_SDK_KEY'}}
});
