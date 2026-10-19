// QR text encoding is built into the app's React Native 0.81 runtime.
require('../../scripts/patch-mobile-metro.cjs')();
const {getDefaultConfig}=require('expo/metro-config');
const config=getDefaultConfig(__dirname);
module.exports=config;
