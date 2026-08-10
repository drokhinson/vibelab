// Placeholder shell — replaced by the real provider + navigation tree in the
// foundation milestone. Exists so the scaffold commit boots and bundles.
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function MainApp() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: '#FAF4E8', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#2A211C' }}>BoardgameBuddy</Text>
          <Text style={{ fontSize: 13, color: '#8A7A6B', marginTop: 6 }}>rebuilding…</Text>
        </View>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
