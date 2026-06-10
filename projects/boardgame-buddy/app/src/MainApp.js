// BoardgameBuddy native root. Kept separate from App.js so a module-load
// failure here is caught by App.js's diagnostic boundary.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { Home, Dices, User, Lock } from 'lucide-react-native';
import { useFonts, Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { CrimsonText_400Regular, CrimsonText_600SemiBold, CrimsonText_700Bold } from '@expo-google-fonts/crimson-text';
import { Fraunces_400Regular_Italic, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';

import { AppProvider, useAppState } from './store/AppContext';
import { handleAuthDeepLink } from './auth/oauth';
import { COLORS, FONTS } from './theme';
import LoadingState from './components/LoadingState';
import ConfirmHost from './components/ConfirmModal';
import { PlayDetailHost } from './widgets/PlayDetailPopup';

import FeedScreen from './screens/FeedScreen';
import SearchScreen from './screens/SearchScreen';
import LogPlayScreen from './screens/LogPlayScreen';
import PlayFlowScreen from './screens/PlayFlowScreen';
import SessionViewerScreen from './screens/SessionViewerScreen';
import JoinSessionScreen from './screens/JoinSessionScreen';
import SessionRouter from './screens/SessionRouter';
import GameDetailScreen from './screens/GameDetailScreen';
import ChapterEditorScreen from './screens/ChapterEditorScreen';
import ProfileSelfScreen from './screens/ProfileSelfScreen';
import ProfileOtherScreen from './screens/ProfileOtherScreen';
import CollectionScreen from './screens/CollectionScreen';
import PlaysScreen from './screens/PlaysScreen';
import BuddiesScreen from './screens/BuddiesScreen';
import SettingsScreen from './screens/SettingsScreen';
import AdminScreen from './screens/AdminScreen';
import AuthScreen from './screens/AuthScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TabIcon({ Icon, color, size, locked }) {
  return (
    <View style={{ width: size + 4, height: size + 4, alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={size} color={color} />
      {locked ? (
        <View style={{ position: 'absolute', top: -2, right: -2, width: 12, height: 12, borderRadius: 6, backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center' }}>
          <Lock size={9} color={COLORS.textMuted} />
        </View>
      ) : null}
    </View>
  );
}

function HomeTabs() {
  const state = useAppState();
  const isAnon = !state.currentUser;
  return (
    <Tab.Navigator
      initialRouteName="FeedTab"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.accent,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: { backgroundColor: COLORS.card, borderTopColor: COLORS.border },
        tabBarLabelStyle: { fontSize: 11, fontFamily: FONTS.sansSemibold },
      }}
    >
      <Tab.Screen
        name="FeedTab"
        component={FeedScreen}
        options={{ title: 'Feed', tabBarIcon: ({ color, size }) => <TabIcon Icon={Home} color={color} size={size} /> }}
      />
      <Tab.Screen
        name="PlayTab"
        component={LogPlayScreen}
        options={{ title: 'Play', tabBarIcon: ({ color, size }) => <TabIcon Icon={Dices} color={color} size={size} locked={isAnon} /> }}
      />
      <Tab.Screen
        name="ProfileTab"
        component={ProfileSelfScreen}
        options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <TabIcon Icon={User} color={color} size={size} locked={isAnon} /> }}
      />
    </Tab.Navigator>
  );
}

function BootGate({ children }) {
  const { authReady } = useAppState();
  if (!authReady) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center' }}>
        <LoadingState label="Setting the table…" />
      </View>
    );
  }
  return children;
}

const linking = {
  prefixes: [Linking.createURL('/'), 'boardgamebuddy://', 'https://vibelab-boardgamebuddy.vercel.app'],
  config: {
    screens: {
      Home: { screens: { FeedTab: 'feed', PlayTab: 'play', ProfileTab: 'profile' } },
      GameDetail: 'game/:gameId',
      SessionRouter: 'play/:code',
      JoinSession: 'join',
      ProfileOther: 'u/:userId',
      Settings: 'settings',
      Admin: 'admin',
    },
  },
};

function NavRoot() {
  return (
    <NavigationContainer linking={linking}>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{ headerShown: false, animation: 'slide_from_right', contentStyle: { backgroundColor: COLORS.bg } }}
      >
        <Stack.Screen name="Home" component={HomeTabs} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="GameDetail" component={GameDetailScreen} />
        <Stack.Screen name="ChapterEditor" component={ChapterEditorScreen} />
        <Stack.Screen name="PlayFlow" component={PlayFlowScreen} />
        <Stack.Screen name="SessionViewer" component={SessionViewerScreen} />
        <Stack.Screen name="SessionRouter" component={SessionRouter} />
        <Stack.Screen name="JoinSession" component={JoinSessionScreen} />
        <Stack.Screen name="ProfileOther" component={ProfileOtherScreen} />
        <Stack.Screen name="Collection" component={CollectionScreen} />
        <Stack.Screen name="Plays" component={PlaysScreen} />
        <Stack.Screen name="Buddies" component={BuddiesScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="Admin" component={AdminScreen} />
        <Stack.Screen name="Auth" component={AuthScreen} options={{ presentation: 'modal' }} />
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
    CrimsonText_400Regular,
    CrimsonText_600SemiBold,
    CrimsonText_700Bold,
    Fraunces_400Regular_Italic,
    Fraunces_600SemiBold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  // OAuth deep-link fallback (the Supabase client also listens internally).
  useEffect(() => {
    let active = true;
    Linking.getInitialURL().then((url) => {
      if (active && url) handleAuthDeepLink(url).catch(() => {});
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) handleAuthDeepLink(url).catch(() => {});
    });
    return () => {
      active = false;
      sub?.remove?.();
    };
  }, []);

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center' }}>
          <LoadingState label="Setting the table…" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <BottomSheetModalProvider>
            <BootGate>
              <NavRoot />
            </BootGate>
            <PlayDetailHost />
            <ConfirmHost />
          </BottomSheetModalProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
