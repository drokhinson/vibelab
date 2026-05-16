// Wizard step 1 — Source. Four bubble-style cards: URL paste, file pick,
// Manual Entry, and a disabled Instagram Reel placeholder. Mirrors web's
// renderBuilderSource (web/builder.js:105-173).

import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { Link2, FileUp, PenLine, ArrowRight, Download } from 'lucide-react-native';
import LoadingPot from '../../components/LoadingPot';
import builderStyles from './builderStyles';
import { COLORS, SHADOWS } from '../../theme';

// Hosted alongside the web prototype. Same file the web's "Download AI
// recipe builder instructions" link points at.
const AI_INSTRUCTIONS_URL = 'https://sauceboss-omega.vercel.app/assets/sb-ai-recipe-instructions.md';

export default function SourceStep({
  importUrl,
  setImportUrl,
  importing,
  importError,
  handleImport,
  handleImportFromFile,
  handleManualStart,
}) {
  return (
    <View>
      {/* Bubble 1 — URL. Input above + Import button below so the URL has
          full width to breathe and the button isn't crammed against the
          input edge. */}
      <View style={styles.bubble}>
        <View style={styles.bubbleHeader}>
          <View style={[styles.bubbleIconWrap, { backgroundColor: '#FFE0CC' }]}>
            <Link2 size={20} color={COLORS.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.bubbleTitle}>Import from URL</Text>
            <Text style={styles.bubbleSubtitle}>Paste a recipe link</Text>
          </View>
        </View>
        <TextInput
          style={[builderStyles.input, styles.urlInput]}
          value={importUrl}
          onChangeText={setImportUrl}
          placeholder="https://example.com/recipe"
          placeholderTextColor={COLORS.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[builderStyles.smallBtn, styles.importBtn, (!importUrl || importing) && builderStyles.btnDisabled]}
          onPress={handleImport}
          disabled={!importUrl || importing}
          activeOpacity={0.8}
        >
          {importing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={builderStyles.smallBtnLabel}>Import</Text>
          )}
        </TouchableOpacity>
        {importError ? <Text style={builderStyles.error}>{importError}</Text> : null}
        {importing ? <LoadingPot label="Importing recipe…" /> : null}
      </View>

      {/* Bubble 2 — File. Two actions: pick a .sauce.json to import, or
          download the AI instructions guide (same as web). */}
      <View style={styles.bubble}>
        <View style={styles.bubbleHeader}>
          <View style={[styles.bubbleIconWrap, { backgroundColor: '#E0F2FE' }]}>
            <FileUp size={20} color="#0369A1" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.bubbleTitle}>Import from File</Text>
            <Text style={styles.bubbleSubtitle}>Upload a JSON file in the SauceBoss format</Text>
          </View>
        </View>
        <View style={styles.fileActionsRow}>
          <TouchableOpacity
            style={[builderStyles.smallBtnSecondary, importing && builderStyles.btnDisabled, { flex: 1 }]}
            onPress={handleImportFromFile}
            disabled={importing}
            activeOpacity={0.8}
          >
            <FileUp size={14} color={COLORS.primary}  />
            <Text style={builderStyles.smallBtnSecondaryLabel}>Choose File</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[builderStyles.smallBtnSecondary, { flex: 1 }]}
            onPress={() => Linking.openURL(AI_INSTRUCTIONS_URL).catch(() => {})}
            activeOpacity={0.8}
          >
            <Download size={14} color={COLORS.primary}  />
            <Text style={builderStyles.smallBtnSecondaryLabel}>Instructions</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Bubble 3 — Manual */}
      <TouchableOpacity
        style={styles.bubble}
        onPress={handleManualStart}
        disabled={importing}
        activeOpacity={0.8}
      >
        <View style={styles.bubbleHeader}>
          <View style={[styles.bubbleIconWrap, { backgroundColor: '#FEF3C7' }]}>
            <PenLine size={20} color="#B45309" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.bubbleTitle}>Manual Entry</Text>
            <Text style={styles.bubbleSubtitle}>Enter all info by hand</Text>
          </View>
          <ArrowRight size={16} color={COLORS.textSecondary} />
        </View>
      </TouchableOpacity>

      {/* Bubble 4 — Instagram (disabled, coming soon) */}
      <View style={[styles.bubble, styles.bubbleDisabled]}>
        <View style={styles.bubbleHeader}>
          <View style={[styles.bubbleIconWrap, { backgroundColor: '#F3E8FF' }]}>
            <Text style={{ fontSize: 18 }}>📱</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.bubbleTitle, styles.bubbleTitleMuted]}>Import from Instagram Reel</Text>
            <Text style={styles.bubbleSubtitle}>Paste a Reel URL</Text>
          </View>
          <View style={styles.comingSoonBadge}>
            <Text style={styles.comingSoonLabel}>Soon</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.sm,
  },
  bubbleDisabled: {
    opacity: 0.55,
  },
  bubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  // URL field + Import button stack vertically so the URL has full width
  // and the button is comfortably below it (mirrors web's two-line layout).
  urlInput: {
    marginTop: 12,
  },
  importBtn: {
    marginTop: 10,
    alignSelf: 'flex-end',
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  bubbleIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
  },
  bubbleTitleMuted: {
    color: COLORS.textSecondary,
  },
  bubbleSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  fileActionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
  },
  comingSoonBadge: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  comingSoonLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
