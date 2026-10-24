# Browser-native patterns

Small platform primitives cover more UI than they first appear to. Prefer these
before reaching for a dependency:

| Need | Native pattern | Details |
| --- | --- | --- |
| Navigation | `<a href>` | Preserve open-in-new-tab, copy-link, and history behavior. |
| Action | `<button type="button">` | Give it a name; use `type="submit"` only inside an intentional form. |
| Form | `<form>` + `<label>` | Use `required`, `inputmode`, `autocomplete`, and `checkValidity()` where useful. |
| Disclosure | `<details><summary>` | Works without JavaScript and has a familiar keyboard model. |
| Modal | `<dialog>` | Use `showModal()`, a labelled heading, a cancel path, and close on explicit action. |
| Non-modal popup | `popover` | Use `popovertarget` when a transient menu or help surface should not trap focus. |
| Layout | CSS grid/flex + custom properties | Let content drive dimensions; use `minmax()`, `clamp()`, and container queries. |
| Overflowing table | Semantic `<table>` inside a scroll container | Keep table semantics. If the table needs horizontal scrolling, provide labelled native scroll buttons instead of adding `tabindex` to a noninteractive wrapper. Give each scroll container a unique `id`, match both buttons with `aria-controls`, and initialize every pair independently. |
| Async request | `fetch()` + `AbortController` | Cancel stale work, handle non-2xx responses, and show loading/error states. |
| Small persistence | `localStorage` | Version keys, handle unavailable storage, and never store secrets. |
| Reusable behavior | Custom element | Define a narrow attribute/event API and keep light-DOM semantics when possible. |

For accessible status, update a concise `role="status"` region rather than moving
focus for every background change. For a true alert, use `role="alert"` sparingly.
Use `inert` when temporarily disabling an underlying surface, and restore focus to
the invoking control when a dialog or popover closes.

## Preview hosting

Cloud previews run with opaque origins. Their CSP sandbox blocks native form
submissions, and browser storage or network requests may be unavailable. Keep
forms useful without relying on submission to a remote endpoint, handle rejected
storage or requests when they are an enhancement, and explain any action that
requires leaving the preview.
