import React from 'react';
import { Linking, Text } from 'react-native';
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION } from './config.js';

/** Fields to send with sign-up so the account records which terms the person agreed to. */
export function termsAcceptance() {
  return TERMS_VERSION ? { termsVersion: TERMS_VERSION } : {};
}

function DocLink({ url, label, color }) {
  if (!/^https:\/\//.test(url)) return <Text>{label}</Text>;
  return (
    <Text accessibilityRole="link" style={{ color, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(url).catch(() => {})}>
      {label}
    </Text>
  );
}

/** Shown above the create-account button. */
export function LegalNotice({ style, linkColor }) {
  return (
    <Text style={[{ fontSize: 13, lineHeight: 19, marginVertical: 10 }, style]}>
      By creating an account you agree to the ELESEND <DocLink url={TERMS_URL} label="Terms of Service" color={linkColor} /> and confirm you have read the <DocLink url={PRIVACY_URL} label="Privacy Notice" color={linkColor} />, which explains how your phone number, location and order details are used.
    </Text>
  );
}
