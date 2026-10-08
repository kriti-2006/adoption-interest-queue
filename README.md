# Adoption Interest Queue

> Ticket **ENG-22666** · Epic: Core Infrastructure Overhaul · Priority: P1

A lightweight, offline-first web tool that lets shelter floor staff record, track and manage people who want to adopt an animal, in the order they registered.

## Project Overview

**Problem.** The shelter tracked adoption interest on paper and in Excel spreadsheets. Records were lost, duplicated, and slow to find, and there was no single source of truth for who was next in line.

**Solution.** A single-page browser application with no backend and no build step. Staff can add interests through a validated form, see the queue in order with clear positions, search it instantly, update statuses, inspect full details and remove entries. Data is kept in the browser's `localStorage`, so the queue keeps working when the shelter's connection is unreliable.

## Features

- **Queue dashboard**: title, description, live queue count, search, "Add Interest" button, and a table with position, applicant, email, phone, animal, type, status, date added and actions.
- **Add interest**: modal form with JavaScript validation (not only browser-native), red highlighting plus text error messages, an error summary, focus moved to the first invalid field, and a duplicate check (same email and animal name).
- **Search**: instant and case-insensitive across applicant name, email, phone, animal name, animal type and status. Multiple words narrow results (`dog pending`), and digit-only searches also match phone numbers regardless of formatting (`0101` matches `(555) 010-0101`). Clear with the button or the Escape key.
- **Queue actions**: change status (Pending, Contacted, Approved, Declined), view full details, and remove with a confirmation dialog.
- **Queue ordering**: new interests join the end; positions are recalculated on removal; every record gets a unique generated ID (`crypto.randomUUID()` with a fallback), and duplicate IDs found in storage are reassigned.
- **Persistence**: `localStorage` with graceful handling of unavailable storage, failed writes (quota, privacy mode), corrupted JSON, unexpected shapes and invalid field values. Changes made in another tab are picked up automatically.
- **Slow-connection simulation**: add, status update and remove each run through a short simulated request with visible loading indicators and duplicate-submission protection. Append `?simulateFailure` to the URL to test the failure paths.
- **Empty states**: "No adoption interests yet." with an Add Interest action, and "No data found" with a Clear search action.
- **XSS protection**: all user text is rendered with `textContent` or escaped with `escapeHTML()`.
- **Accessibility**: semantic landmarks, native `<dialog>` modals, labelled controls, live-region announcements, visible focus and full keyboard operation.
- **Telemetry simulation**: `trackAnalytics()` logs `[Analytics] User interacted with Adoption Interest Queue` to the console after each successful add, status update or removal. The payload holds only the action, record ID and status, never personal data.
- **Toasts**: non-blocking success and error messages that pause while hovered or focused.
- **Responsive**: works on desktop, tablet and mobile; the table scrolls horizontally on narrow screens and dialogs fit the viewport.

## Tech Stack

- HTML5
- CSS3 (custom properties for design tokens)
- Vanilla JavaScript (ES2020+)

No frameworks, libraries, build tools or runtime dependencies. Unit tests use Node's built-in test runner (Node 18+), so `npm test` needs no `npm install`.

## Running Locally

Open `index.html` directly in a modern browser (Chrome, Edge, Firefox or Safari).

Some browsers restrict or isolate `localStorage` for `file://` pages. If data does not persist between reloads, serve the folder locally:

```bash
cd adoption-interest-queue
python -m http.server 8000
```

Then open: <http://localhost:8000>

To try the failed-request handling: <http://localhost:8000/?simulateFailure>

### Resetting the demo data

On first load (when nothing is stored yet) three fictional demo records are added. They are tagged **Demo**, use `example.com` addresses and `555-01xx` numbers, and can be removed like any other record. To start completely fresh, run `localStorage.clear()` in the browser console and reload. Removing every record leaves the queue empty; demo data is not re-added.

## Architecture

Everything lives in `app.js` inside a single IIFE, so nothing leaks into the global scope.

### State management

A single `state` object is the source of truth:

```js
const state = {
  adoptionInterests: [],     // the queue, in order
  searchQuery: '',
  loading: false,            // add request in flight
  pendingUpdates: new Map(), // per-row requests in flight (status / remove)
  storageAvailable: true,
};
```

State changes only through small action functions (`addAdoptionInterest`, `updateStatus`, `removeAdoptionInterest`) that replace the array immutably, call `persistChanges()`, and then `render()`.

### Rendering

`render()` derives everything from state: the count, the search summary, and either the table (`renderQueue`) or an empty state (`renderEmptyState`). Rows are rebuilt with `createElement`. Focus is restored to the equivalent control after a re-render, so keyboard users never lose their place.

### Persistence

- `loadState()` reads `localStorage`, parses defensively and runs every record through `normalizeInterest()`, which sanitises fields, defaults invalid statuses or types, validates dates and replaces missing or duplicate IDs.
- Corrupted JSON is caught, a copy is saved under `adoption-interest-queue:corrupt-backup`, the queue resets to empty, and the user sees a notice.
- `saveState()` never throws. A failed write shows the toast "Your changes could not be saved locally. Please try again." while the in-memory queue keeps working.
- If storage is unavailable entirely, the app runs in memory and shows a persistent notice.

### Validation

`validateForm()` runs a validator per field and returns errors in form order. Invalid fields get `aria-invalid`, a red border and background, and a text message ("Error: …") linked with `aria-describedby`. An error summary (`role="alert"`) appears at the top of the form, and focus moves to the first invalid field. Errors clear as soon as the field becomes valid.

| Field | Rule |
| --- | --- |
| Applicant name | Required |
| Email | Required, `name@domain.tld` format |
| Phone | Required; digits, spaces, `+ ( ) - .`; 7–15 digits |
| Animal name | Required |
| Animal type | One of Dog, Cat, Rabbit, Bird, Other |
| Notes | Optional, up to 500 characters |

### XSS protection

- `sanitizeInput()` normalises untrusted text (strips control characters, collapses whitespace, trims, caps length).
- `escapeHTML()` escapes `& < > " '` and is used for the only template-string render (the details dialog).
- Everywhere else, values go through `textContent`, so input such as `<script>alert("XSS")</script>` is displayed as text and never executed.

### Accessibility

- Landmarks: `header`, `main`, `section`, `footer`, and a skip link to the queue.
- One `h1`, `h2` per section and dialog, `h3` for the empty state.
- A real `<table>` with a caption, column headers and the applicant name as the row header. The scroll container is focusable and labelled.
- Every control has a visible or visually hidden label. Row buttons include hidden context (for example, "View details for Sarah Johnson").
- Native `<dialog>` with `showModal()` traps focus and closes on Escape (blocked while its request is in flight). Focus returns to the triggering control, or to a sensible neighbour after a removal.
- Polite and assertive live regions announce loading, success, errors, search result counts and empty states.
- Status and errors never rely on colour alone (text labels, "Error:" prefixes, and border style and weight differences).
- Loading buttons use `aria-disabled` instead of `disabled` so focus is not lost.
- `prefers-reduced-motion` is respected.

### Design system

All colours, spacing (8 / 16 / 24 / 32 px), radii, type sizes and control heights are CSS custom properties at the top of `styles.css`. The palette is neutral; one restrained red is reserved for errors and destructive actions. All text meets WCAG AA contrast.

## Automated Tests

The pure logic (sanitising, validation, duplicate detection, record normalisation and search) lives in `core.js`, which has no DOM access and is loaded by both the browser and Node. `app.js` handles state, rendering and events.

```bash
npm test
```

Tests are in `tests/core.test.js`.

## Manual Testing Checklist

| Area | Acceptance criteria |
| --- | --- |
| Happy path | App loads with demo data · add interest appends at the end with the next position · search filters instantly · status update persists · remove (after confirmation) renumbers positions · data survives a refresh |
| Validation | Empty name / invalid email / empty phone / bad phone / empty animal name / no animal type are each blocked, highlighted and announced; focus goes to the first invalid field; queue unchanged · valid form succeeds · duplicate email + animal is blocked |
| Empty states | Removing every record shows "No adoption interests yet." with Add Interest · a search with no matches shows "No data found" with Clear search |
| Security | `<script>alert("XSS")</script>` and `<img src=x onerror=alert(1)>` in every text field render as text in the table and details, and nothing executes |
| Persistence | Add, refresh, record remains · status change, refresh, status remains |
| Corrupted storage | `localStorage.setItem('adoption-interest-queue:v1', '{oops')`, reload: no crash, empty queue, notice shown, backup kept · duplicate IDs and invalid statuses are repaired |
| Storage failure | Unavailable storage: app works in memory with a notice · failed write: toast "Your changes could not be saved locally. Please try again." |
| Async | Loading indicator during add / update / remove · double submit adds only one record · `?simulateFailure`: errors shown, queue unchanged, form values kept |
| Accessibility | Whole app operable by keyboard · visible focus · dialogs trap focus and close with Escape · errors announced · Lighthouse Accessibility = 100 |
| Responsive | 1280px, 768px and 375px: no page-level horizontal overflow; table scrolls inside its container; form stacks; dialog fits |
| Telemetry | Console shows `[Analytics] User interacted with Adoption Interest Queue` after add / update / remove |

## Known Limitations

- Data lives in one browser on one device. Clearing site data deletes the queue, and there is no sync between devices or staff members. A backend is the natural next step.
- `localStorage` is limited to roughly 5 MB per origin, which is ample for thousands of records.
- The "network" is simulated; there is no real server, authentication or audit log.
- Requires a browser with native `<dialog>` support (all current evergreen browsers).
- If two tabs edit at the same moment, the last write wins (other tabs refresh when they detect the change).
