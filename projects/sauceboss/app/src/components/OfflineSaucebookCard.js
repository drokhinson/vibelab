// Settings card for the Offline Saucebook feature.
// Displays toggle + storage usage and surfaces sync state (idle / downloading
// / pending / error). The screen above owns the toggle handler (so it can
// fire the destructive Alert before disabling).

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { Download, RefreshCw } from 'lucide-react-native';
import { COLORS, SHADOWS } from '../theme';
import { formatBytes, formatRelative } from '../offline/cache';

export default function OfflineSaucebookCard({ offline, onToggle, onRetry }) {
  const enabled = !!offline?.enabled;
  const syncing = !!offline?.syncing;
  const pending = !!offline?.pendingDownload;
  const progress = offline?.progress; // { done, total } | null
  const bytes = offline?.bytes || 0;
  const count = offline?.count || 0;

  let statusNode = null;
  if (enabled) {
    if (syncing) {
      statusNode = (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={COLORS.primary} />
          <Text style={[styles.statusText, { marginTop: 0, marginLeft: 8 }]}>
            {progress
              ? `Downloading… ${progress.done} of ${progress.total}`
              : 'Downloading…'}
          </Text>
        </View>
      );
    } else if (pending) {
      statusNode = (
        <View>
          <Text style={styles.statusText}>
            Pending — will download when you're back online.
          </Text>
          <TouchableOpacity
            onPress={onRetry}
            style={styles.retryBtn}
            activeOpacity={0.7}
          >
            <RefreshCw size={14} color={COLORS.primary} />
            <Text style={styles.retryLabel}>Retry now</Text>
          </TouchableOpacity>
        </View>
      );
    } else {
      statusNode = (
        <Text style={styles.statusText}>
          {count > 0
            ? `${formatBytes(bytes)} · ${count} ${count === 1 ? 'recipe' : 'recipes'} cached · Synced ${formatRelative(offline?.lastSyncedAt)}`
            : 'No recipes to cache yet — add some sauces to your saucebook.'}
        </Text>
      );
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Download size={18} color={COLORS.text} />
        <View style={styles.headerText}>
          <Text style={styles.title}>Offline Saucebook</Text>
          <Text style={styles.help}>
            Save your saucebook to this device so you can read recipes without a connection.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ false: COLORS.border, true: COLORS.primary }}
          thumbColor="#fff"
        />
      </View>
      {statusNode}
      {offline?.error && !syncing ? (
        <Text style={styles.errorText}>{offline.error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    ...SHADOWS.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  headerText: {
    flex: 1,
    marginLeft: 10,
    marginRight: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 4,
  },
  help: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    marginLeft: 8,
  },
  statusText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 12,
    marginLeft: 8,
    lineHeight: 18,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    marginLeft: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSubtle,
  },
  retryLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    marginLeft: 6,
  },
  errorText: {
    color: COLORS.dangerText,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
    marginLeft: 8,
  },
});
