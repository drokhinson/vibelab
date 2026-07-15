// src/MainApp.js — navigation, providers, font loading, and the OAuth deep-link
// listener. Auth-gated: no session → AuthScreen; session → the Feed/Log/Profile
// bottom tabs (wrapped in a native-stack so later phases push detail screens).

import React, { useEffect } from 'react';
import { View, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Newspaper, Dice5, CircleUser } from 'lucide-react-native';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';
import {
  CrimsonText_600SemiBold,
  CrimsonText_700Bold,
} from '@expo-google-fonts/crimson-text';

import { AppProvider, useAppState, useAppActions } from './store/AppContext';
import { ConfirmProvider } from './components/ConfirmModal';
import { handleAuthDeepLink } from './auth/oauth';
import { api } from './api/client';
import AuthScreen from './screens/AuthScreen';
import FeedScreen from './screens/FeedScreen';
import LogPlayScreen from './screens/LogPlayScreen';
import ProfileSelfScreen from './screens/ProfileSelfScreen';
import LoadingState from './components/LoadingState';
import { COLORS, FONTS } from './theme';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function HomeTabs() {
  return (
    <Tab.Navigator
      initialRouteName="FeedTab"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.accentHover,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: { backgroundColor: COLORS.card, borderTopColor: COLORS.border },
        tabBarLabelStyle: { fontFamily: FONTS.semibold, fontSize: 11 },
      }}
    >
      <Tab.Screen
        name="FeedTab"
        component={FeedScreen}
        options={{ title: 'Feed', tabBarIcon: ({ color, size }) => <Newspaper size={size} color={color} /> }}
      />
      <Tab.Screen
        name="LogTab"
        component={LogPlayScreen}
        options={{ title: 'Log', tabBarIcon: ({ color, size }) => <Dice5 size={size} color={color} /> }}
      />
      <Tab.Screen
        name="ProfileTab"
        component={ProfileSelfScreen}
        options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <CircleUser size={size} color={color} /> }}
      />
    </Tab.Navigator>
  );
}

function Root() {
  const { authReady, session } = useAppState();
  const actions = useAppActions();

  // Tab-focus / app-foreground warm refresh (RN AppState in place of the web's
  // visibilitychange listener): serve cache immediately, refresh live blocks.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && session && actions.warmRefresh) actions.warmRefresh();
    });
    return () => sub.remove();
  }, [session, actions]);

  if (!authReady) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background }}>
        <LoadingState label="Loading…" />
      </View>
    );
  }

  if (!session) return <AuthScreen />;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Home" component={HomeTabs} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function MainApp() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
    CrimsonText_600SemiBold,
    CrimsonText_700Bold,
  });

  // OAuth deep-link handshake. The bridge bounces the browser into the app via
  // `boardgamebuddy://auth-callback?code=…` (cold start → getInitialURL, warm →
  // the url listener). handleAuthDeepLink dedupes so both firing is safe.
  useEffect(() => {
    let active = true;
    Linking.getInitialURL().then((url) => {
      if (active && url) handleAuthDeepLink(url).catch(() => {});
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleAuthDeepLink(url).catch(() => {});
    });
    return () => { active = false; sub?.remove?.(); };
  }, []);

  useEffect(() => { api.trackEvent('app_open'); }, []);

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background }}>
        <LoadingState />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AppProvider>
          <ConfirmProvider>
            <Root />
          </ConfirmProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
