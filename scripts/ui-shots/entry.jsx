import React from 'react';import {AppRegistry} from 'react-native';
import CustomerApp from '../../apps/mobile/src/customer/CustomerApp';import RiderApp from '../../apps/mobile/src/rider/RiderApp';
const q=new URLSearchParams(location.search);AppRegistry.registerComponent('A',()=>q.get('app')==='rider'?RiderApp:CustomerApp);AppRegistry.runApplication('A',{rootTag:document.getElementById('root')});
