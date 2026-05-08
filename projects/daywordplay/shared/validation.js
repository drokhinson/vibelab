import { GROUP_CODE_LEN, MIN_SENTENCE_LEN, MIN_GROUP_NAME_LEN, MAX_GROUP_NAME_LEN } from './constants.js';

export function validateSentence(text, requiredWord) {
  const trimmed = (text || '').trim();
  if (trimmed.length < MIN_SENTENCE_LEN) {
    return { ok: false, error: 'Please write a longer sentence.' };
  }
  if (requiredWord && !trimmed.toLowerCase().includes(String(requiredWord).toLowerCase())) {
    return { ok: false, error: `Your sentence must include "${requiredWord}".` };
  }
  return { ok: true };
}

export function validateGroupName(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < MIN_GROUP_NAME_LEN) {
    return { ok: false, error: `Group name must be at least ${MIN_GROUP_NAME_LEN} characters.` };
  }
  if (trimmed.length > MAX_GROUP_NAME_LEN) {
    return { ok: false, error: `Group name must be ${MAX_GROUP_NAME_LEN} characters or fewer.` };
  }
  return { ok: true };
}

export function normalizeGroupCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, GROUP_CODE_LEN);
}

export function validateGroupCode(code) {
  const cleaned = normalizeGroupCode(code);
  if (cleaned.length !== GROUP_CODE_LEN) {
    return { ok: false, error: `Enter a valid ${GROUP_CODE_LEN}-character code.` };
  }
  return { ok: true, code: cleaned };
}

export function validateProposedWord({ word, partOfSpeech, definition }) {
  if (!word || !word.trim()) return { ok: false, error: 'Word is required.' };
  if (!partOfSpeech || !partOfSpeech.trim()) return { ok: false, error: 'Part of speech is required.' };
  if (!definition || !definition.trim()) return { ok: false, error: 'Definition is required.' };
  return { ok: true };
}
