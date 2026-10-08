'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

const validValues = () => ({
  applicantName: 'Jordan Lee',
  email: 'jordan@example.com',
  phone: '(555) 010-1234',
  animalName: 'Biscuit',
  animalType: 'Dog',
  notes: '',
});

const interest = (overrides = {}) => ({
  id: 'a1',
  applicantName: 'Jordan Lee',
  email: 'jordan@example.com',
  phone: '555-0101',
  animalName: 'Biscuit',
  animalType: 'Dog',
  status: 'Pending',
  ...overrides,
});

describe('sanitizeInput', () => {
  test('returns an empty string for non-string input', () => {
    assert.equal(core.sanitizeInput(undefined), '');
    assert.equal(core.sanitizeInput(42), '');
    assert.equal(core.sanitizeInput(null), '');
  });

  test('trims and collapses whitespace on single-line input', () => {
    assert.equal(core.sanitizeInput('  Jordan \t\n  Lee  '), 'Jordan Lee');
  });

  test('strips control characters', () => {
    assert.equal(core.sanitizeInput('Bis\u0000cu\u0007it\u007F'), 'Biscuit');
  });

  test('keeps line breaks in multiline mode and normalises CRLF', () => {
    assert.equal(core.sanitizeInput('line one\r\nline two\rline three', { multiline: true }), 'line one\nline two\nline three');
  });

  test('caps length at maxLength', () => {
    assert.equal(core.sanitizeInput('abcdef', { maxLength: 3 }), 'abc');
  });
});

describe('escapeHTML', () => {
  test('escapes all HTML-significant characters', () => {
    assert.equal(core.escapeHTML(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  test('treats null and undefined as empty', () => {
    assert.equal(core.escapeHTML(null), '');
    assert.equal(core.escapeHTML(undefined), '');
  });
});

describe('generateId', () => {
  test('returns an ID not already in use that matches ID_PATTERN', () => {
    const used = new Set(['a', 'b']);
    const id = core.generateId(used);
    assert.ok(!used.has(id));
    assert.match(id, core.ID_PATTERN);
  });
});

describe('VALIDATORS / validateForm', () => {
  test('accepts a complete, valid form', () => {
    assert.deepEqual(core.validateForm(validValues(), []), []);
  });

  test('reports every missing required field in form order', () => {
    const errors = core.validateForm({ applicantName: '', email: '', phone: '', animalName: '', animalType: '' }, []);
    assert.deepEqual(errors.map((e) => e.field), ['applicantName', 'email', 'phone', 'animalName', 'animalType']);
  });

  for (const email of ['no-at-sign', 'a@b', 'a@b.c', 'a b@example.com', 'a@@example.com', 'a@.example.com']) {
    test(`rejects invalid email "${email}"`, () => {
      assert.notEqual(core.VALIDATORS.email({ email }), '');
    });
  }

  for (const email of ['jordan@example.com', 'first.last+tag@mail.example.co.uk']) {
    test(`accepts valid email "${email}"`, () => {
      assert.equal(core.VALIDATORS.email({ email }), '');
    });
  }

  for (const phone of ['123456', '1234567890123456', '555-CALL-NOW', '++15550101234']) {
    test(`rejects invalid phone "${phone}"`, () => {
      assert.notEqual(core.VALIDATORS.phone({ phone }), '');
    });
  }

  for (const phone of ['5550101', '+1 (555) 010-1234', '555.010.1234', '123456789012345']) {
    test(`accepts valid phone "${phone}"`, () => {
      assert.equal(core.VALIDATORS.phone({ phone }), '');
    });
  }

  test('rejects an animal type that is not in ANIMAL_TYPES', () => {
    assert.notEqual(core.VALIDATORS.animalType({ animalType: 'Dragon' }), '');
  });

  test('flags a duplicate email + animal name, ignoring case', () => {
    const existing = [interest({ email: 'JORDAN@example.com', animalName: 'biscuit' })];
    const errors = core.validateForm(validValues(), existing);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, 'animalName');
  });

  test('allows the same applicant to express interest in a different animal', () => {
    const existing = [interest({ animalName: 'Pepper' })];
    assert.deepEqual(core.validateForm(validValues(), existing), []);
  });

  test('only checks duplicates once field errors are fixed', () => {
    const existing = [interest()];
    const errors = core.validateForm({ ...validValues(), phone: '' }, existing);
    assert.deepEqual(errors.map((e) => e.field), ['phone']);
  });
});

describe('normalizeInterests', () => {
  test('drops records without an applicant or animal name', () => {
    const { interests, repairedCount } = core.normalizeInterests([
      interest(),
      interest({ id: 'a2', applicantName: '   ' }),
      interest({ id: 'a3', animalName: undefined }),
      null,
      'not an object',
    ]);
    assert.equal(interests.length, 1);
    assert.equal(repairedCount, 4);
  });

  test('replaces missing, invalid and duplicate IDs', () => {
    const { interests, repairedCount } = core.normalizeInterests([
      interest({ id: 'same' }),
      interest({ id: 'same' }),
      interest({ id: '<script>' }),
      interest({ id: undefined }),
    ]);
    const ids = interests.map((i) => i.id);
    assert.equal(ids[0], 'same');
    assert.equal(new Set(ids).size, 4);
    ids.forEach((id) => assert.match(id, core.ID_PATTERN));
    assert.equal(repairedCount, 3);
  });

  test('defaults unknown status and animal type', () => {
    const { interests } = core.normalizeInterests([interest({ status: 'Adopted!', animalType: 'Dragon' })]);
    assert.equal(interests[0].status, 'Pending');
    assert.equal(interests[0].animalType, 'Other');
  });

  test('replaces invalid dates and falls back updatedAt to createdAt', () => {
    const createdAt = '2026-01-02T03:04:05.000Z';
    const [withDates] = core.normalizeInterests([interest({ createdAt, updatedAt: 'nope' })]).interests;
    assert.equal(withDates.createdAt, createdAt);
    assert.equal(withDates.updatedAt, createdAt);

    const [withoutDates] = core.normalizeInterests([interest({ createdAt: 'nope' })]).interests;
    assert.ok(!Number.isNaN(Date.parse(withoutDates.createdAt)));
  });

  test('only treats isSample === true as a sample', () => {
    const { interests } = core.normalizeInterests([
      interest({ id: 's1', isSample: true }),
      interest({ id: 's2', isSample: 'true' }),
    ]);
    assert.deepEqual(interests.map((i) => i.isSample), [true, false]);
  });
});

describe('searchAdoptionInterests', () => {
  const entries = [
    interest({ id: 'a1', applicantName: 'Jordan Lee', animalName: 'Biscuit', animalType: 'Dog', phone: '(555) 010-1234' }),
    interest({ id: 'a2', applicantName: 'Sam Patel', email: 'sam@example.com', animalName: 'Mochi', animalType: 'Cat', status: 'Approved', phone: '555 010 9876' }),
  ].map((item, index) => ({ interest: item, position: index + 1 }));

  test('returns every entry for an empty or blank query', () => {
    assert.equal(core.searchAdoptionInterests(entries, ''), entries);
    assert.equal(core.searchAdoptionInterests(entries, '   '), entries);
  });

  test('matches case-insensitively across fields', () => {
    assert.deepEqual(core.searchAdoptionInterests(entries, 'MOCHI').map((e) => e.interest.id), ['a2']);
    assert.deepEqual(core.searchAdoptionInterests(entries, 'approved').map((e) => e.interest.id), ['a2']);
  });

  test('requires every term to match', () => {
    assert.deepEqual(core.searchAdoptionInterests(entries, 'jordan dog').map((e) => e.interest.id), ['a1']);
    assert.deepEqual(core.searchAdoptionInterests(entries, 'jordan cat'), []);
  });

  test('matches phone numbers regardless of formatting', () => {
    assert.deepEqual(core.searchAdoptionInterests(entries, '5550101234').map((e) => e.interest.id), ['a1']);
    assert.deepEqual(core.searchAdoptionInterests(entries, '010-9876').map((e) => e.interest.id), ['a2']);
  });

  test('does not phone-match on fewer than three digits', () => {
    assert.equal(core.matchesPhoneDigits('55', '5550101234'), false);
  });

  test('keeps original queue positions', () => {
    const [match] = core.searchAdoptionInterests(entries, 'sam');
    assert.equal(match.position, 2);
  });
});
