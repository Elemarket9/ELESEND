const esbuild=require('esbuild'),path=require('path');const R=process.env.ROOT;
const mock=path.join(R,'scripts/kasoa/mock.js'),map=path.join(R,'scripts/kasoa/map.jsx');
const plugin={name:'a',setup(b){
 b.onResolve({filter:/^react-native$/},()=>({path:require.resolve('react-native-web')}));
 b.onResolve({filter:/^(expo($|-)|@maplibre|@react-native|react-native-)/},a=>a.path==='react-native-web'||a.path.startsWith('react-native-web/')||a.path.startsWith('@react-native/normalize')?null:({path:mock}));
 b.onResolve({filter:/maps\/map-adapter/},()=>({path:map}));
}};
const go=(name,code)=>esbuild.build({stdin:{contents:code,resolveDir:path.join(R,'apps/mobile/src'),loader:'jsx'},bundle:true,outfile:`/tmp/ui/${name}.js`,loader:{'.js':'jsx','.png':'dataurl'},plugins:[plugin],define:{'process.env.NODE_ENV':'"development"','process.env.EXPO_PUBLIC_ELESEND_API_BASE_URL':'"https://api.example.test"','process.env.EXPO_PUBLIC_ELESEND_SUPPORT_PHONE':'"+233240000000"','process.env':'{}',__DEV__:'false',global:'window'},nodePaths:['/tmp/ui/node_modules'],logLevel:'error'}).then(()=>console.log('built',name));
const mount=m=>`import React from 'react';import {createRoot} from 'react-dom/client';import App from '${m}';createRoot(document.getElementById('root')).render(<App/>);`;
Promise.all([go('customer',mount('./customer/CustomerApp')),go('rider',mount('./rider/RiderApp'))]).catch(e=>{console.error(String(e).slice(0,1500));});
