// RoundScoreGrid — rounds × players scoring table. Column headers are UserBadges
// (forceInitials). Cells are editable text inputs when `editable`. Real prop
// callbacks replace the web widget's string-handler contract. Used by PlayFlow
// (Play phase), SessionViewer (own column editable), PlayDetailPopup (read-only).

import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Plus, Minus, Crown } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import UserBadge from '../components/UserBadge';

// Persisted preference for the per-cell +/− sign buttons. Defaults OFF — many
// phone keyboards already expose a minus key, so the toggle is opt-in.
const SIGN_PREF_KEY = 'bgb.scoring.showSign';

// Sign-toggle transition mirrors the web grid: '' → '-', '-' → '',
// '-5' → '5', '5' → '-5'. Cells are stored as strings so a leading minus
// survives.
function nextSignToggle(v) {
  const s = v == null ? '' : String(v);
  if (s === '') return '-';
  if (s === '-') return '';
  return s.charAt(0) === '-' ? s.slice(1) : '-' + s;
}

/**
 * @param {Object} props
 * @param {Array} props.players  [{ key, name, user_id, avatar }]
 * @param {number} props.rounds  number of round rows
 * @param {(playerIdx:number, roundIdx:number)=>string|number|null} props.getCell
 * @param {(playerIdx:number)=>number} props.getTotal
 * @param {(playerIdx:number)=>boolean} [props.isWinner]
 * @param {(playerIdx:number)=>boolean} [props.canEditColumn] gate per-column edit (joiner = own only)
 * @param {(playerIdx:number, roundIdx:number, value:string)=>void} props.onSetCell
 * @param {() => void} [props.onAddRound]
 * @param {(roundIdx:number)=>void} [props.onRemoveRound]
 * @param {(playerIdx:number)=>void} [props.onToggleWinner]
 * @param {boolean} [props.editable]
 */
export default function RoundScoreGrid({
  players,
  rounds,
  getCell,
  getTotal,
  isWinner,
  canEditColumn,
  onSetCell,
  onAddRound,
  onRemoveRound,
  onToggleWinner,
  editable = true,
}) {
  const roundList = Array.from({ length: Math.max(0, rounds) }, (_, i) => i);

  // Per-cell sign toggles — opt-in, remembered across launches.
  const [showSign, setShowSign] = useState(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(SIGN_PREF_KEY)
      .then((v) => { if (alive) setShowSign(v === '1'); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const toggleSign = () => {
    setShowSign((on) => {
      const next = !on;
      AsyncStorage.setItem(SIGN_PREF_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  };
  const flipSign = (pi, ri) => onSetCell(pi, ri, nextSignToggle(getCell(pi, ri)));

  return (
    <View style={styles.wrap}>
      {editable ? (
        <View style={styles.signHeader}>
          <Pressable
            style={[styles.signToggle, showSign && styles.signToggleOn]}
            onPress={toggleSign}
            accessibilityRole="button"
            accessibilityState={{ selected: showSign }}
          >
            <Text style={[styles.signToggleLabel, showSign && styles.signToggleLabelOn]}>
              {'±'} Negative {showSign ? 'on' : 'off'}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {/* Header row */}
          <View style={styles.row}>
            <View style={styles.rowLabelCell}><Text style={styles.cornerLabel}>Rnd</Text></View>
            {players.map((p, pi) => (
              <Pressable key={p.key || pi} style={styles.headCell} onPress={() => editable && onToggleWinner && onToggleWinner(pi)} disabled={!editable || !onToggleWinner}>
                <UserBadge avatar={p.avatar} displayName={p.name} size="sm" isGhost={!p.user_id} forceInitials />
                <Text style={styles.headName} numberOfLines={1}>{p.name}</Text>
                {isWinner && isWinner(pi) ? <Crown size={13} color={COLORS.accent} fill={COLORS.accent} /> : null}
              </Pressable>
            ))}
          </View>

          {/* Round rows */}
          {roundList.map((ri) => (
            <View key={ri} style={styles.row}>
              <View style={styles.rowLabelCell}>
                <Text style={styles.rowLabel}>{ri + 1}</Text>
                {editable && onRemoveRound && ri === roundList.length - 1 && roundList.length > 1 ? (
                  <Pressable onPress={() => onRemoveRound(ri)} hitSlop={6}><Minus size={13} color={COLORS.rustText} /></Pressable>
                ) : null}
              </View>
              {players.map((p, pi) => {
                const colEditable = editable && (!canEditColumn || canEditColumn(pi));
                const val = getCell(pi, ri);
                const isNeg = val != null && String(val).charAt(0) === '-';
                return (
                  <View key={p.key || pi} style={styles.cell}>
                    {colEditable ? (
                      <View style={styles.cellRow}>
                        {showSign ? (
                          <Pressable
                            style={[styles.signBtn, isNeg && styles.signBtnNeg]}
                            onPress={() => flipSign(pi, ri)}
                            hitSlop={6}
                            accessibilityLabel="Toggle positive or negative"
                          >
                            <Text style={[styles.signBtnLabel, isNeg && styles.signBtnLabelNeg]}>
                              {isNeg ? '−' : '+'}
                            </Text>
                          </Pressable>
                        ) : null}
                        <TextInput
                          style={[styles.cellInput, showSign && styles.cellInputWithSign, isNeg && styles.cellInputNeg]}
                          keyboardType="numeric"
                          value={val == null ? '' : String(val)}
                          onChangeText={(t) => onSetCell(pi, ri, t)}
                          placeholder="–"
                          placeholderTextColor={COLORS.polaroidMuted}
                        />
                      </View>
                    ) : (
                      <Text style={[styles.cellText, isNeg && styles.cellTextNeg]}>{val == null ? '–' : String(val)}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          ))}

          {/* Totals row */}
          <View style={[styles.row, styles.totalRow]}>
            <View style={styles.rowLabelCell}><Text style={styles.totalLabel}>Σ</Text></View>
            {players.map((p, pi) => {
              const tot = getTotal(pi);
              return (
                <View key={p.key || pi} style={[styles.cell, isWinner && isWinner(pi) && styles.winnerCol]}>
                  <Text style={[styles.totalVal, Number(tot) < 0 && styles.totalValNeg]}>{tot}</Text>
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {editable && onAddRound ? (
        <Pressable style={styles.addRound} onPress={onAddRound}>
          <Plus size={15} color={COLORS.polaroidAccent} />
          <Text style={styles.addRoundLabel}>Add round</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const COL = 64;
const styles = StyleSheet.create({
  wrap: { backgroundColor: COLORS.polaroidBg, borderRadius: RADII.lg, padding: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowLabelCell: { width: 40, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, gap: 2 },
  cornerLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidMuted, fontSize: 11 },
  headCell: { width: COL, alignItems: 'center', paddingVertical: 6, gap: 2 },
  headName: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidInk, fontSize: 11, maxWidth: COL - 6 },
  rowLabel: { fontFamily: FONTS.score, color: COLORS.polaroidInkSoft, fontSize: 13 },
  cell: { width: COL, alignItems: 'center', paddingVertical: 4, paddingHorizontal: 4 },
  cellRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cellInput: { width: COL - 12, textAlign: 'center', backgroundColor: COLORS.polaroidBgSoft, borderRadius: RADII.sm, paddingVertical: 6, fontFamily: FONTS.scoreBold, color: COLORS.polaroidInk, fontSize: 15 },
  cellInputWithSign: { width: COL - 32 },
  cellInputNeg: { color: COLORS.rust },
  cellText: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidInkSoft, fontSize: 15 },
  cellTextNeg: { color: COLORS.rust },
  signHeader: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: SPACING.sm },
  signToggle: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: COLORS.polaroidLine, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  signToggleOn: { backgroundColor: COLORS.rust, borderColor: COLORS.rust },
  signToggleLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidInkSoft, fontSize: 12 },
  signToggleLabelOn: { color: '#fff' },
  signBtn: { width: 22, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.polaroidLine, borderRadius: RADII.sm, backgroundColor: COLORS.polaroidBgSoft },
  signBtnNeg: { backgroundColor: COLORS.rust, borderColor: COLORS.rust },
  signBtnLabel: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidInkSoft, fontSize: 17, lineHeight: 18 },
  signBtnLabelNeg: { color: '#fff' },
  totalRow: { borderTopWidth: 1, borderTopColor: COLORS.polaroidLine, marginTop: 4, paddingTop: 4 },
  totalLabel: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidAccent, fontSize: 14 },
  totalVal: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidInk, fontSize: 16 },
  totalValNeg: { color: COLORS.rust },
  winnerCol: { backgroundColor: COLORS.accent + '22', borderRadius: RADII.sm },
  addRound: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: SPACING.sm, paddingVertical: 9, borderRadius: RADII.md, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.polaroidAccent + '88' },
  addRoundLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidAccent, fontSize: 14 },
});
