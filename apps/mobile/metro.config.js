// QR text encoding is built into the app's React Native 0.81 runtime.
const {getDefaultConfig} = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
module.exports = config;
