import { strict as assert } from 'node:assert';
import test from 'node:test';
import { LOCALES } from '../constants.ts';
import { createTranslator, resolveLocale, translate } from './index.ts';
import { en } from './en.ts';
import { km } from './km.ts';

test('every English key has a Khmer translation and vice versa', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(km).sort());
});

test('no Khmer value was left as untranslated English', () => {
  // A handful of strings are intentionally identical (brand names, "English").
  const allowed = new Set(['common.english', 'auth.google', 'auth.apple', 'common.khmer']);
  const untranslated = Object.keys(en).filter(
    (key) => !allowed.has(key) && km[key as keyof typeof en] === en[key as keyof typeof en],
  );
  assert.deepEqual(untranslated, [], 'these keys are still English in km.ts');
});

test('Khmer strings actually contain Khmer script', () => {
  const khmerRange = /[ក-៿]/;
  assert.ok(khmerRange.test(km['nav.dashboard']));
  assert.ok(khmerRange.test(km['onboarding.title']));
});

test('interpolation replaces named vars and leaves unknown ones alone', () => {
  assert.equal(translate('en', 'dashboard.welcome', { name: 'Dara' }), 'Welcome back, Dara');
  assert.equal(
    translate('en', 'placeholder.body', {}),
    '{section} is not part of Phase 1. The navigation is ready for it.',
  );
  const t = createTranslator('km');
  assert.ok(t('dashboard.welcome', { name: 'Dara' }).includes('Dara'));
});

test('resolveLocale falls back instead of trusting input', () => {
  for (const locale of LOCALES) assert.equal(resolveLocale(locale), locale);
  assert.equal(resolveLocale('fr'), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  assert.equal(resolveLocale({ toString: () => 'km' }), 'en');
});
