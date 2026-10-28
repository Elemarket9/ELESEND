// CommonJS extension is required because this app declares type: module.
const {getDefaultConfig} = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
module.exports = config;
