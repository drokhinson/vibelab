// Day Word Play app shell. Kept separate from App.js so module-load failures
// here surface in the diagnostic boundary instead of producing the opaque
// "main has not been registered" Invariant Violation.

import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import { Bookmark, Trophy, Settings as SettingsIcon, Users } from 'lucide-react-native';

import { AppProvider, useAppActions, useAppState } from './store/AppContext';
import { trackAppOpen } from './utils/analytics';
import LoadingState from './components/LoadingState';
import DwpMark from './components/DwpMark';
import AuthScreen from './screens/AuthScreen';
import HomeScreen from './screens/HomeScreen';
import VoteScreen from './screens/VoteScreen';
import LeaderboardScreen from './screens/LeaderboardScreen';
import GroupsScreen from './screens/GroupsScreen';
import JoinByCodeScreen from './screens/JoinByCodeScreen';
import CreateGroupScreen from './screens/CreateGroupScreen';
import DictionaryScreen from './screens/DictionaryScreen';
import ProposeWordScreen from './screens/ProposeWordScreen';
import ProfileScreen from './screens/ProfileScreen';
import AdminScreen from './screens/AdminScreen';
import { COLORS } from './theme';

const RootStack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

function MainTabs({ navigation }) {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.background },
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '800', color: COLORS.primary },
        headerTitle: 'Day Word Play',
        headerRight: () => (
          <Pressable
            onPress={() => navigation.navigate('Profile')}
            hitSlop={8}
            style={{ paddingHorizontal: 12 }}
          >
            <SettingsIcon size={22} color={COLORS.textSecondary} />
          </Pressable>
        ),
        headerLeft: () => (
          <Pressable
            onPress={() => navigation.navigate('Groups')}
            hitSlop={8}
            style={{ paddingHorizontal: 12 }}
          >
            <Users size={22} color={COLORS.textSecondary} />
          </Pressable>
        ),
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: {
          backgroundColor: COLORS.surface,
          borderTopColor: COLORS.border,
        },
        sceneContainerStyle: { backgroundColor: COLORS.background },
      }}
    >
      <Tabs.Screen
        name="Dictionary"
        component={DictionaryScreen}
        options={{ tabBarIcon: ({ color, size }) => <Bookmark size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="Word"
        component={HomeScreen}
        options={{ tabBarIcon: ({ color, size }) => <DwpMark size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="Stats"
        component={LeaderboardScreen}
        options={{ tabBarIcon: ({ color, size }) => <Trophy size={size} color={color} /> }}
      />
    </Tabs.Navigator>
  );
}

function AuthedStack() {
  return (
    <RootStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.background },
        headerTintColor: COLORS.primary,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: COLORS.background },
      }}
    >
      <RootStack.Screen name="Tabs" component={MainTabs} options={{ headerShown: false }} />
      <RootStack.Screen name="Vote" component={VoteScreen} options={{ title: 'Vote' }} />
      <RootStack.Screen name="Groups" component={GroupsScreen} options={{ title: 'Groups' }} />
      <RootStack.Screen
        name="JoinByCode"
        component={JoinByCodeScreen}
        options={{ title: 'Join by Code', presentation: 'modal' }}
      />
      <RootStack.Screen
        name="CreateGroup"
        component={CreateGroupScreen}
        options={{ title: 'Create Group', presentation: 'modal' }}
      />
      <RootStack.Screen
        name="ProposeWord"
        component={ProposeWordScreen}
        options={{ title: 'Propose a Word', presentation: 'modal' }}
      />
      <RootStack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
      <RootStack.Screen name="Admin" component={AdminScreen} options={{ title: 'Admin' }} />
    </RootStack.Navigator>
  );
}

function GuestStack() {
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.background } }}>
      <RootStack.Screen name="Auth" component={AuthScreen} />
    </RootStack.Navigator>
  );
}

function NavRoot() {
  const { authReady, session, currentUser } = useAppState();
  const { handleAuthDeepLink } = useAppActions();

  // Catch OAuth deep links whenever the OS hands a URL off to the app.
  useEffect(() => {
    let active = true;
    Linking.getInitialURL().then((url) => {
      if (active && url) handleAuthDeepLink(url).catch(() => {});
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleAuthDeepLink(url).catch(() => {});
    });
    return () => { active = false; sub?.remove?.(); };
  }, [handleAuthDeepLink]);

  if (!authReady) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center' }}>
        <LoadingState label="Loading…" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="dark" backgroundColor={COLORS.background} />
      {session && currentUser ? <AuthedStack /> : <GuestStack />}
    </NavigationContainer>
  );
}

export default function MainApp() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => { trackAppOpen(); }, []);

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center' }}>
          <LoadingState label="Loading…" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AppProvider>
        <NavRoot />
      </AppProvider>
    </SafeAreaProvider>
  );
}
