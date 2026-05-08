// Supabase auth storage adapter backed by expo-secure-store on device, with
// AsyncStorage as a fallback for keys exceeding SecureStore's 2 KB limit.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SECURE_LIMIT_BYTES = 1800;

function tooLarge(value) {
  return typeof value === 'string' && value.length > SECURE_LIMIT_BYTES;
}

export const secureStorage = {
  async getItem(key) {
    try {
      const fromSecure = await SecureStore.getItemAsync(key);
      if (fromSecure != null) return fromSecure;
    } catch {
      // SecureStore can throw on iOS sim without a passcode set; fall through.
    }
    return AsyncStorage.getItem(key);
  },

  async setItem(key, value) {
    if (tooLarge(value)) {
      try { await SecureStore.deleteItemAsync(key); } catch {}
      return AsyncStorage.setItem(key, value);
    }
    try {
      await SecureStore.setItemAsync(key, value);
      return null;
    } catch {
      return AsyncStorage.setItem(key, value);
    }
  },

  async removeItem(key) {
    try { await SecureStore.deleteItemAsync(key); } catch {}
    return AsyncStorage.removeItem(key);
  },
};
