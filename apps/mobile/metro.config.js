// Keep QR text encoding compatible with Expo Metro and react-native-qrcode-svg.
const {getDefaultConfig}=require('expo/metro-config');
const config=getDefaultConfig(__dirname);
config.transformer={...config.transformer,babelTransformerPath:require.resolve('react-native-qrcode-svg/textEncodingTransformation')};
module.exports=config;
