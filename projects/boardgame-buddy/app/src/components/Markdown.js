// Markdown — lightweight renderer for reference-guide chapter content. Supports
// the subset the web guide uses: headings (#, ##), bold (**), italic (*),
// bullet lists (-, *), numbered lists, and paragraphs. No external dep.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, FONTS } from '../theme';

function renderInline(text, keyPrefix) {
  // Split on **bold** and *italic* while keeping delimiters.
  const parts = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = regex.exec(text))) {
    if (m.index > last) parts.push(<Text key={`${keyPrefix}-t${i++}`}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(<Text key={`${keyPrefix}-b${i++}`} style={styles.bold}>{tok.slice(2, -2)}</Text>);
    } else {
      parts.push(<Text key={`${keyPrefix}-i${i++}`} style={styles.italic}>{tok.slice(1, -1)}</Text>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<Text key={`${keyPrefix}-t${i++}`}>{text.slice(last)}</Text>);
  return parts;
}

export default function Markdown({ content, style }) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('## ')) {
      blocks.push(<Text key={idx} style={styles.h2}>{renderInline(trimmed.slice(3), `h2${idx}`)}</Text>);
    } else if (trimmed.startsWith('# ')) {
      blocks.push(<Text key={idx} style={styles.h1}>{renderInline(trimmed.slice(2), `h1${idx}`)}</Text>);
    } else if (/^[-*]\s+/.test(trimmed)) {
      blocks.push(
        <View key={idx} style={styles.li}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.liText}>{renderInline(trimmed.replace(/^[-*]\s+/, ''), `li${idx}`)}</Text>
        </View>,
      );
    } else if (/^\d+\.\s+/.test(trimmed)) {
      const num = trimmed.match(/^(\d+)\./)[1];
      blocks.push(
        <View key={idx} style={styles.li}>
          <Text style={styles.bullet}>{num}.</Text>
          <Text style={styles.liText}>{renderInline(trimmed.replace(/^\d+\.\s+/, ''), `ol${idx}`)}</Text>
        </View>,
      );
    } else {
      blocks.push(<Text key={idx} style={styles.p}>{renderInline(trimmed, `p${idx}`)}</Text>);
    }
  });
  return <View style={style}>{blocks}</View>;
}

const styles = StyleSheet.create({
  h1: { fontFamily: FONTS.displayBold, color: COLORS.polaroidInk, fontSize: 20, marginTop: 8, marginBottom: 4 },
  h2: { fontFamily: FONTS.display, color: COLORS.polaroidInk, fontSize: 17, marginTop: 6, marginBottom: 3 },
  p: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidInkSoft, fontSize: 15, lineHeight: 22, marginBottom: 6 },
  li: { flexDirection: 'row', gap: 6, marginBottom: 3, paddingLeft: 4 },
  bullet: { fontFamily: FONTS.score, color: COLORS.polaroidAccent, fontSize: 14, lineHeight: 22 },
  liText: { flex: 1, fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidInkSoft, fontSize: 15, lineHeight: 22 },
  bold: { fontFamily: FONTS.sansBold },
  italic: { fontStyle: 'italic' },
});
