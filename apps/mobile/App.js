/**
 * ELESEND Mobile Application Root Dispatcher
 * 
 * Dynamically resolves either the Customer or Rider application based on
 * the build configuration (EXPO_PUBLIC_ELESEND_APP_VARIANT).
 * 
 * - Default: Customer Application (ELESEND)
 * - Rider: Courier Application (ELESEND Rider)
 */

import React from 'react';
import CustomerApp from './src/customer/CustomerApp';
import RiderApp from './src/rider/RiderApp';

const appVariant = (process.env.EXPO_PUBLIC_ELESEND_APP_VARIANT || 'customer').trim().toLowerCase();

export default function App() {
  if (appVariant === 'rider') {
    return <RiderApp />;
  }
  return <CustomerApp />;
}
