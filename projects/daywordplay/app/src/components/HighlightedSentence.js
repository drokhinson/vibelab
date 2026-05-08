import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { tokenizeWithWord } from '#shared/format';
import { COLORS } from '../theme';

export default function HighlightedSentence({ sentence, word, style, highlightStyle }) {
  const tokens = tokenizeWithWord(sentence || '', word || '');
  return (
    <Text style={style}>
      {tokens.map((tok, i) => (
        <Text key={i} style={tok.highlight ? [styles.highlight, highlightStyle] : null}>
          {tok.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  highlight: { color: COLORS.highlight, fontWeight: '700' },
});
