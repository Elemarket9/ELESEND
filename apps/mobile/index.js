import {registerRootComponent} from 'expo';
import './src/tracking'; // Top-level task registration is required by OS background launches.
import App from './App';
registerRootComponent(App);
