import { strict as assert } from 'node:assert';
import test from 'node:test';
import { isNormalizedPhone, isValidPhone, normalizePhone } from './phone.ts';

test('every way of writing one Cambodian number normalises to the same string', () => {
  const same = [
    '012345678',
    '012 345 678',
    '012-345-678',
    '(012) 345 678',
    '012.345.678',
    '+85512345678',
    '+855 12 345 678',
    '+855 (0)12 345 678',
    '85512345678',
    '0085512345678',
    '00 855 12 345 678',
    '  012345678  ',
  ];
  for (const input of same) {
    assert.equal(normalizePhone(input), '+85512345678', input);
  }
});

test('9-digit and no-trunk-prefix local numbers work too', () => {
  assert.equal(normalizePhone('077123456'), '+85577123456');
  assert.equal(normalizePhone('0967654321'), '+855967654321');
  // Typed without the leading zero, as people often do in chat.
  assert.equal(normalizePhone('12345678'), '+85512345678');
});

test('foreign numbers keep their own country code', () => {
  assert.equal(normalizePhone('+66812345678'), '+66812345678');
  assert.equal(normalizePhone('+84 90 123 4567'), '+84901234567');
  assert.equal(normalizePhone('0066812345678'), '+66812345678');
});

test('a local number that merely starts with 855 is not read as a country code', () => {
  // 0855123456 -> the leading 0 is the trunk prefix, 855123456 is the number.
  assert.equal(normalizePhone('0855123456'), '+855855123456');
});

test('input with no digits normalises to null', () => {
  for (const input of ['', '   ', 'not a phone', '+', '-- --', null, undefined]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});

test('isNormalizedPhone enforces the E.164 shape', () => {
  assert.equal(isNormalizedPhone('+85512345678'), true);
  assert.equal(isNormalizedPhone('+855123'), false, 'too short');
  assert.equal(isNormalizedPhone('85512345678'), false, 'missing +');
  assert.equal(isNormalizedPhone('+0855123456'), false, 'country code cannot start with 0');
  assert.equal(isNormalizedPhone(null), false);
});

test('isValidPhone rejects numbers that are too short to dial', () => {
  assert.equal(isValidPhone('012345678'), true);
  assert.equal(isValidPhone('0123'), false);
  assert.equal(isValidPhone('hello'), false);
});
