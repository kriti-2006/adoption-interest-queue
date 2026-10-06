'use strict';

/**
 * Adoption Interest Queue — core logic
 *
 * Pure functions with no DOM access: input sanitising, validation, record
 * normalisation and search. Loaded by the browser as `window.AdoptionQueueCore`
 * and by Node (for the unit tests) via `require('./core.js')`.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.AdoptionQueueCore = core;
})(typeof self !== 'undefined' ? self : this, () => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const STATUSES = Object.freeze(['Pending', 'Contacted', 'Approved', 'Declined']);
  const ANIMAL_TYPES = Object.freeze(['Dog', 'Cat', 'Rabbit', 'Bird', 'Other']);
  const LIMITS = Object.freeze({
    applicantName: 100,
    email: 254,
    phone: 20,
    animalName: 60,
    notes: 500,
    search: 100,
  });
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;
  const PHONE_PATTERN = /^\+?[\d\s().-]+$/;
  const PHONE_DIGITS = Object.freeze({ min: 7, max: 15 });

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** Normalises untrusted text: strips control characters, collapses whitespace, trims and caps length. */
  function sanitizeInput(value, { maxLength = 500, multiline = false } = {}) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const withoutControlChars = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    const normalised = multiline
      ? withoutControlChars.replace(/\r\n?/g, '\n')
      : withoutControlChars.replace(/\s+/g, ' ');
    return normalised.trim().slice(0, maxLength);
  }

  const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

  /** Escapes text for safe use inside an HTML template string. */
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function generateId(usedIds) {
    const { crypto } = globalThis;
    const createCandidate = () => (crypto && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    let id = createCandidate();
    while (usedIds.has(id)) id = createCandidate();
    return id;
  }

  function isValidDateString(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }

  function countDigits(value) {
    return value.replace(/\D/g, '').length;
  }

  // ---------------------------------------------------------------------------
  // Record normalisation (guards against malformed or tampered data)
  // ---------------------------------------------------------------------------
  function normalizeInterest(raw, usedIds) {
    if (!raw || typeof raw !== 'object') return null;

    const applicantName = sanitizeInput(raw.applicantName, { maxLength: LIMITS.applicantName });
    const animalName = sanitizeInput(raw.animalName, { maxLength: LIMITS.animalName });
    if (!applicantName || !animalName) return null;

    const hasUsableId = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) && !usedIds.has(raw.id);
    const id = hasUsableId ? raw.id : generateId(usedIds);
    usedIds.add(id);

    const createdAt = isValidDateString(raw.createdAt) ? raw.createdAt : new Date().toISOString();

    return {
      repaired: !hasUsableId,
      record: {
        id,
        applicantName,
        email: sanitizeInput(raw.email, { maxLength: LIMITS.email }),
        phone: sanitizeInput(raw.phone, { maxLength: LIMITS.phone }),
        animalName,
        animalType: ANIMAL_TYPES.includes(raw.animalType) ? raw.animalType : 'Other',
        status: STATUSES.includes(raw.status) ? raw.status : 'Pending',
        notes: sanitizeInput(raw.notes, { maxLength: LIMITS.notes, multiline: true }),
        createdAt,
        updatedAt: isValidDateString(raw.updatedAt) ? raw.updatedAt : createdAt,
        isSample: raw.isSample === true,
      },
    };
  }

  function normalizeInterests(list) {
    const usedIds = new Set();
    const interests = [];
    let repairedCount = 0;

    list.forEach((raw) => {
      const result = normalizeInterest(raw, usedIds);
      if (!result) {
        repairedCount += 1;
        return;
      }
      if (result.repaired) repairedCount += 1;
      interests.push(result.record);
    });

    return { interests, repairedCount };
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  function matchesPhoneDigits(term, phoneDigits) {
    if (/[a-z]/i.test(term)) return false;
    const digits = term.replace(/\D/g, '');
    return digits.length >= 3 && phoneDigits.includes(digits);
  }

  /** Case-insensitive; every whitespace-separated term must match a field. Keeps original queue positions. */
  function searchAdoptionInterests(entries, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;

    return entries.filter(({ interest }) => {
      const haystack = [
        interest.applicantName,
        interest.email,
        interest.phone,
        interest.animalName,
        interest.animalType,
        interest.status,
      ].join('\n').toLowerCase();
      const phoneDigits = interest.phone.replace(/\D/g, '');
      return terms.every((term) => haystack.includes(term) || matchesPhoneDigits(term, phoneDigits));
    });
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  const VALIDATORS = Object.freeze({
    applicantName: ({ applicantName }) => (applicantName ? '' : "Please enter the applicant's name."),
    email: ({ email }) => {
      if (!email) return 'Please enter an email address.';
      return EMAIL_PATTERN.test(email) ? '' : 'Please enter a valid email address.';
    },
    phone: ({ phone }) => {
      if (!phone) return 'Please enter a phone number.';
      const digits = countDigits(phone);
      const isValid = PHONE_PATTERN.test(phone) && digits >= PHONE_DIGITS.min && digits <= PHONE_DIGITS.max;
      return isValid ? '' : 'Please enter a valid phone number using 7 to 15 digits, for example (555) 010-1234.';
    },
    animalName: ({ animalName }) => (animalName ? '' : "Please enter the animal's name."),
    animalType: ({ animalType }) => (ANIMAL_TYPES.includes(animalType) ? '' : 'Please select an animal type.'),
  });

  function isDuplicateInterest({ email, animalName }, interests) {
    const emailKey = email.toLowerCase();
    const animalKey = animalName.toLowerCase();
    return interests.some(
      (interest) => interest.email.toLowerCase() === emailKey && interest.animalName.toLowerCase() === animalKey,
    );
  }

  /** Returns errors in form (DOM) order so the first one can receive focus. */
  function validateForm(values, interests) {
    const errors = Object.entries(VALIDATORS)
      .map(([field, validate]) => ({ field, message: validate(values) }))
      .filter(({ message }) => message);

    if (errors.length === 0 && isDuplicateInterest(values, interests)) {
      errors.push({
        field: 'animalName',
        message: `An interest from this email address for an animal named ${values.animalName} is already in the queue.`,
      });
    }
    return errors;
  }

  return Object.freeze({
    STATUSES,
    ANIMAL_TYPES,
    LIMITS,
    ID_PATTERN,
    sanitizeInput,
    escapeHTML,
    generateId,
    isValidDateString,
    countDigits,
    normalizeInterest,
    normalizeInterests,
    matchesPhoneDigits,
    searchAdoptionInterests,
    VALIDATORS,
    isDuplicateInterest,
    validateForm,
  });
});
