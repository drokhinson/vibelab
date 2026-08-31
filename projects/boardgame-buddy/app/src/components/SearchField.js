// components/SearchField.js — the × that clears a search box, once, for every
// search box in the native app.
//
// Three surfaces had grown the same field by hand — the collection screen, the
// buddies screen and GameFinder — each repeating the identical `searchRow` +
// `input` StyleSheet pair, and none of them offering a way to empty the box
// short of holding backspace. That is instance #3 of one lifecycle, which is
// where `.claude/rules/ui-object-design.md` §4 says to extract.
//
// The web counterpart is `web/ui/search-field.js`; this is the same contract in
// React idiom. There the × has to be delegated because hosts repaint by
// replacing innerHTML — here `value` is already the single source of truth, so
// the button simply renders when the query is non-empty and calls the caller's
// own `onChangeText('')`. Every call site already reacts to that (a debounced
// search, a filter, a state setter), so clearing needs no per-screen code.
//
// `clearButtonMode="never"` is deliberate: iOS would otherwise draw its own ×
// beside ours. One affordance, and it looks the same on both platforms.

import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';

/**
 * @param {object} props
 * @param {string} props.value                Current query. Drives the ×'s presence.
 * @param {(text: string) => void} props.onChangeText
 * @param {string} [props.placeholder]
 * @param {boolean} [props.icon]              Leading magnifier. Default true —
 *   all three existing call sites draw one.
 * @param {React.ReactNode} [props.trailing]  Rendered after the × (GameFinder's
 *   in-flight spinner).
 * @param {string} [props.clearLabel]         The ×'s accessible name.
 * @param {any} [props.style]                 Layout deltas on the wrapper only —
 *   the field's look belongs to this component.
 * @param {any} [props.inputStyle]
 */
const SearchField = forwardRef(function SearchField(
  {
    value,
    onChangeText,
    placeholder,
    icon = true,
    trailing = null,
    clearLabel = 'Clear search',
    style,
    inputStyle,
    ...inputProps
  },
  ref,
) {
  const inputRef = useRef(null);
  useImperativeHandle(ref, () => inputRef.current);

  // Focus stays in the box after clearing: the user's next move is almost
  // always to type a different query, and dropping the keyboard reads as the
  // field having been torn down.
  function clear() {
    onChangeText && onChangeText('');
    inputRef.current && inputRef.current.focus();
  }

  return (
    <View style={[styles.row, style]}>
      {icon ? <Search size={18} color={COLORS.textMuted} /> : null}
      <TextInput
        ref={inputRef}
        style={[styles.input, inputStyle]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        autoCorrect={false}
        clearButtonMode="never"
        {...inputProps}
      />
      {value ? (
        <Pressable
          onPress={clear}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          style={({ pressed }) => [styles.clearBtn, pressed && styles.clearBtnPressed]}
        >
          <X size={16} color={COLORS.textMuted} />
        </Pressable>
      ) : null}
      {trailing}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  input: { flex: 1, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, paddingVertical: 11 },
  clearBtn: { padding: 2, borderRadius: RADII.pill },
  clearBtnPressed: { opacity: 0.55 },
});

export default SearchField;
