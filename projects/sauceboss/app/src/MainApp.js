// SauceBoss App. Kept separate from App.js so a module-load failure here gets
// caught by App.js's diagnostic boundary and the error renders onscreen
// instead of producing the opaque "main not registered" Invariant Violation.

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
import { Compass, BookOpen, Archive, Lock } from 'lucide-react-native';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

import { AppProvider, useAppState } from './store/AppContext';
import LoadingPot from './components/LoadingPot';
import BrowseScreen from './screens/BrowseScreen';
import SaucebookScreen from './screens/SaucebookScreen';
import PantryScreen from './screens/PantryScreen';
import MealBuilderScreen from './screens/MealBuilderScreen';
import PrepSelectorScreen from './screens/PrepSelectorScreen';
import SauceSelectorScreen from './screens/SauceSelectorScreen';
import SauceManagerScreen from './screens/SauceManagerScreen';
import SauceBuilderScreen from './screens/SauceBuilderScreen';
import RecipeScreen from './screens/RecipeScreen';
import SettingsScreen from './screens/SettingsScreen';
import { trackAppOpen } from './utils/analytics';
import { handleAuthDeepLink } from './auth/oauth';
import { COLORS } from './theme';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// Tab icon with optional anonymous-user lock dot. Mirrors web's
// tabs.js lock-badge for Saucebook / Pantry when no session.
function TabIcon({ Icon, color, size, locked }) {
  return (
    <View style={{ width: size + 4, height: size + 4, alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={size} color={color} />
      {locked ? (
        <View
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: COLORS.card,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Lock size={9} color={COLORS.textSecondary} />
        </View>
      ) : null}
    </View>
  );
}

// HomeTabs holds the three primary destinations. The initial tab depends
// on whether the user is signed in (matches web/init.js:61). Locked tabs
// for anonymous users prompt sign-in via the existing AuthModal flow
// instead of switching — handled in tabPress listener (phase 9 polish).
function HomeTabs() {
  const state = useAppState();
  const isAnon = !state.currentUser;
  return (
    <Tab.Navigator
      // Always land on Saucebook — anonymous users see the sign-in empty
      // state on that tab, which is more useful than dropping them on Browse.
      initialRouteName="SaucebookTab"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textSecondary,
        tabBarStyle: { backgroundColor: COLORS.card, borderTopColor: COLORS.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tab.Screen
        name="BrowseTab"
        component={BrowseScreen}
        options={{
          title: 'Browse',
          tabBarIcon: ({ color, size }) => <TabIcon Icon={Compass} color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="SaucebookTab"
        component={SaucebookScreen}
        options={{
          title: 'Saucebook',
          tabBarIcon: ({ color, size }) => (
            <TabIcon Icon={BookOpen} color={color} size={size} locked={isAnon} />
          ),
        }}
      />
      <Tab.Screen
        name="PantryTab"
        component={PantryScreen}
        options={{
          title: 'Pantry',
          tabBarIcon: ({ color, size }) => (
            <TabIcon Icon={Archive} color={color} size={size} locked={isAnon} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// Gate the navigator on auth hydration so signed-in users don't see the
// not-signed-in empty state flicker by during Supabase's getSession() round-trip.
// `authReady` flips true after the auth bootstrap finishes — either with a
// session restored or with no session found, OR immediately when auth isn't
// configured (see AppContext useEffect at line ~912). The fonts gate sits one
// level up in MainApp.
function BootGate({ children }) {
  const { authReady } = useAppState();
  if (!authReady) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center' }}>
        <LoadingPot label="Warming up the kitchen…" />
      </View>
    );
  }
  return children;
}

function NavRoot() {
  return (
    <NavigationContainer>
      <StatusBar style="light" backgroundColor={COLORS.primary} />
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.primary },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '800' },
          headerBackTitleVisible: false,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: COLORS.background },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="MealBuilder"
          component={MealBuilderScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="PrepSelector"
          component={PrepSelectorScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="SauceSelector"
          component={SauceSelectorScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="SauceManager"
          component={SauceManagerScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="SauceBuilder"
          component={SauceBuilderScreen}
          // Plain stack (not `presentation: 'modal'`) so the in-screen
          // BottomSheetModal portals can surface — modal presentation puts
          // the screen above the app-root BottomSheetModalProvider on iOS
          // (FullWindowOverlay), suppressing the Add Ingredient sheet.
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Recipe"
          component={RecipeScreen}
          options={({ route }) => ({ title: 'Sauce' })}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
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

  useEffect(() => {
    trackAppOpen();
  }, []);

  // Catch the OAuth deep link from the web bridge whenever the OS hands a
  // URL off to the app — covers both initial launches (Linking.getInitialURL)
  // and resumes while the app is in the background (Linking.addEventListener).
  // The Supabase JS client also listens for the same event internally to
  // populate the session; this handler is a belt-and-suspenders fallback in
  // case the WebBrowser session was already dismissed when the bridge fired.
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
        <View style={{ flex: 1, backgroundColor: COLORS.background, justifyContent: 'center' }}>
          <LoadingPot label="Warming up the kitchen…" />
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
          </BottomSheetModalProvider>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
