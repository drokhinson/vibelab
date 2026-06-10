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
// Invariant Violation. Tiny indirection; big debug payoff. Keep permanently.
let RealApp = null;
let bootError = null;

try {
  RealApp = require('./src/MainApp').default;
} catch (e) {
  bootError = e;
}

function BootErrorScreen({ error, label = 'Boot error' }) {
  const message = error?.message || String(error);
  const stack = error?.stack || '(no stack)';
  return (
    <View style={{ flex: 1, backgroundColor: '#0d0d14', paddingTop: 56, paddingHorizontal: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: '800', color: '#E07A5F', marginBottom: 8 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, color: '#FFFBF1', marginBottom: 12 }}>{message}</Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
        <Text selectable style={{ fontSize: 11, color: '#C9C2B0', fontFamily: 'monospace' }}>
          {stack}
        </Text>
      </ScrollView>
    </View>
  );
}

// Runtime error boundary — catches errors thrown DURING render/lifecycle of the
// app tree (the import-time try/catch above only covers module load). Without
// this, a render-phase throw falls through to Expo Go's opaque "Something went
// wrong" screen; here we surface the real message + stack on-device instead.
class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) return <BootErrorScreen error={this.state.error} label="Render error" />;
    return this.props.children;
  }
}

function App() {
  if (bootError) return <BootErrorScreen error={bootError} />;
  if (!RealApp) return <BootErrorScreen error={new Error('MainApp is null with no recorded error')} />;
  return (
    <RootErrorBoundary>
      <RealApp />
    </RootErrorBoundary>
  );
}

registerRootComponent(App);

export default App;
