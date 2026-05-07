// URL polyfill must be imported before anything that touches WHATWG URL.
// Hermes ships a URL impl whose `protocol` is getter-only, which breaks
// expo-asset's getManifestBaseUrl on Expo Go SDK 54. The polyfill replaces
// it with a fully-spec-compliant URL.
import 'react-native-url-polyfill/auto';
import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { View, StatusBar as RNStatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';

import { AppProvider } from './src/store/AppContext';
import LoadingPot from './src/components/LoadingPot';
import MealBuilderScreen from './src/screens/MealBuilderScreen';
import PrepSelectorScreen from './src/screens/PrepSelectorScreen';
import SauceSelectorScreen from './src/screens/SauceSelectorScreen';
import MealRecipeScreen from './src/screens/MealRecipeScreen';
import { trackAppOpen } from './src/utils/analytics';
import { COLORS } from './src/theme';

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
          options={({ route }) => ({
            title: 'Pick a sauce',
          })}
        />
        <Stack.Screen
          name="MealRecipe"
          component={MealRecipeScreen}
          options={{ title: 'Your recipe' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
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
