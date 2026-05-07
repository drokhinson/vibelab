// SauceBoss App. Kept separate from App.js so a module-load failure here gets
// caught by App.js's diagnostic boundary and the error renders onscreen
// instead of producing the opaque "main not registered" Invariant Violation.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
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

import { AppProvider } from './store/AppContext';
import LoadingPot from './components/LoadingPot';
import MealBuilderScreen from './screens/MealBuilderScreen';
import PrepSelectorScreen from './screens/PrepSelectorScreen';
import SauceSelectorScreen from './screens/SauceSelectorScreen';
import MealRecipeScreen from './screens/MealRecipeScreen';
import SauceManagerScreen from './screens/SauceManagerScreen';
import SauceBuilderScreen from './screens/SauceBuilderScreen';
import RecipeScreen from './screens/RecipeScreen';
import SettingsScreen from './screens/SettingsScreen';
import { trackAppOpen } from './utils/analytics';
import { handleAuthDeepLink } from './auth/oauth';
import { COLORS } from './theme';

const Stack = createNativeStackNavigator();

function NavRoot() {
  return (
    <NavigationContainer>
      <StatusBar style="light" backgroundColor={COLORS.primary} />
      <Stack.Navigator
        initialRouteName="MealBuilder"
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
          name="MealBuilder"
          component={MealBuilderScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="PrepSelector"
          component={PrepSelectorScreen}
          options={{ title: 'Choose a variant' }}
        />
        <Stack.Screen
          name="SauceSelector"
          component={SauceSelectorScreen}
          options={{ title: 'Pick a sauce' }}
        />
        <Stack.Screen
          name="MealRecipe"
          component={MealRecipeScreen}
          options={{ title: 'Your recipe' }}
        />
        <Stack.Screen
          name="SauceManager"
          component={SauceManagerScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="SauceBuilder"
          component={SauceBuilderScreen}
          options={{ headerShown: false, presentation: 'modal' }}
        />
        <Stack.Screen
          name="Recipe"
          component={RecipeScreen}
          options={({ route }) => ({ title: 'Sauce' })}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings' }}
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
    <SafeAreaProvider>
      <AppProvider>
        <NavRoot />
      </AppProvider>
    </SafeAreaProvider>
  );
}
