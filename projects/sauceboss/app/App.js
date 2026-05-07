// URL polyfill must be imported before anything that touches WHATWG URL.
// Hermes ships a URL impl whose `protocol` is getter-only, which breaks
// expo-asset's getManifestBaseUrl on Expo Go SDK 54.
import 'react-native-url-polyfill/auto';
import 'react-native-gesture-handler';

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';

// Defer the real app to a require() inside try/catch. If any module-level
// import in the dependency tree throws, we render the actual stack trace
// onscreen instead of producing the opaque "main has not been registered"
// Invariant Violation. Tiny indirection; big debug payoff.
let RealApp = null;
let bootError = null;

try {
  RealApp = require('./src/MainApp').default;
} catch (e) {
  bootError = e;
}

function BootErrorScreen({ error }) {
  const message = error?.message || String(error);
  const stack = error?.stack || '(no stack)';
  return (
    <View style={{ flex: 1, backgroundColor: '#FFF8F0', paddingTop: 56, paddingHorizontal: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: '800', color: '#991B1B', marginBottom: 8 }}>
        Boot error
      </Text>
      <Text style={{ fontSize: 13, color: '#1A1A2E', marginBottom: 12 }}>
        {message}
      </Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
        <Text selectable style={{ fontSize: 11, color: '#374151', fontFamily: 'monospace' }}>
          {stack}
        </Text>
      </ScrollView>
    </View>
  );
}

function App() {
  if (bootError) return <BootErrorScreen error={bootError} />;
  if (!RealApp) return <BootErrorScreen error={new Error('MainApp is null with no recorded error')} />;
  return <RealApp />;
}

registerRootComponent(App);

export default App;
