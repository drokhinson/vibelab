import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, ScrollView } from 'react-native';
import { fetchHealth } from '../api/client';

export default function HomeScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchHealth()
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#6c63ff" />
    </View>
  );

  if (error) return (
    <View style={styles.center}>
      <Text style={styles.error}>⚠ {error}</Text>
    </View>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* TODO: Replace with your app UI */}
      <Text style={styles.title}>Day Word Play</Text>
      <Text style={styles.muted}>Replace this with your app content.</Text>
      <Text style={styles.code}>{JSON.stringify(data, null, 2)}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d14' },
  content: { padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0d0d14' },
  title: { fontSize: 24, fontWeight: '700', color: '#ffffff', marginBottom: 8 },
  muted: { fontSize: 14, color: '#8888aa', marginBottom: 16 },
  error: { fontSize: 14, color: '#ff6b6b' },
  code: { fontSize: 12, color: '#aaaacc', fontFamily: 'monospace' },
});
