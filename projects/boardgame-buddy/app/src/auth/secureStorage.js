// Supabase auth storage adapter backed by expo-secure-store on device, with
// AsyncStorage as a fallback for keys exceeding SecureStore's 2 KB limit.
// Mirrors the pattern recommended in @supabase/supabase-js docs for RN.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// SecureStore on iOS Keychain has a hard 2 KB cap per item. Supabase tokens
// fit easily, but PKCE state can occasionally exceed this. Anything larger
// falls back to AsyncStorage transparently.
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
      // SecureStore can throw on iOS simulator without a passcode set; ignore
      // and fall through to AsyncStorage below.
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
