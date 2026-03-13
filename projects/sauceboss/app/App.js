import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SQLiteProvider } from 'expo-sqlite';
import CarbSelectorScreen from './src/screens/CarbSelectorScreen';
import SauceSelectorScreen from './src/screens/SauceSelectorScreen';
import RecipeScreen from './src/screens/RecipeScreen';
import { seedDatabase } from './src/data/database';
import { COLORS } from './src/theme';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <SQLiteProvider databaseName="sauceboss.sqlite" onInit={seedDatabase}>
      <NavigationContainer>
        <StatusBar style="light" backgroundColor={COLORS.primary} />
        <Stack.Navigator
          initialRouteName="CarbSelector"
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
            name="CarbSelector"
            component={CarbSelectorScreen}
            options={{ title: '🍲 SauceBoss', headerLargeTitle: false }}
          />
          <Stack.Screen
            name="SauceSelector"
            component={SauceSelectorScreen}
            options={({ route }) => ({
              title: `${route.params?.carb?.emoji || ''} ${route.params?.carb?.name || ''} Sauces`,
            })}
          />
          <Stack.Screen
            name="Recipe"
            component={RecipeScreen}
            options={({ route }) => ({
              title: route.params?.sauce?.name || 'Recipe',
              headerTransparent: false,
            })}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SQLiteProvider>
  );
}
