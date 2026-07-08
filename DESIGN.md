# Design System: SPT-ANALYTICS

## 1. Visual Theme & Atmosphere

A dense, operational telecom dashboard with restrained motion and high-confidence control surfaces. Density is cockpit-balanced (7/10), variance is predictable with modest asymmetry (4/10), and motion is functional CSS feedback only (3/10). The product should feel like a live PBX operations console used under time pressure, not a decorative analytics landing page.

## 2. Color Palette & Roles

- **Zinc Console** (#09090B) - Primary dark application canvas.
- **Panel Black** (#121212) - Primary panel and toolbar surface.
- **Raised Zinc** (#18181B) - Secondary controls, selected tabs, and nested tool areas.
- **Hover Zinc** (#27272A) - Hover, active, divider, and table row feedback.
- **Structural Zinc** (#3F3F46) - Stronger borders and emphasized separators.
- **Pure White** (#FFFFFF) - Primary dark-theme text and selected icon color.
- **Steel Text** (#A1A1AA) - Secondary labels, metadata, and quiet navigation text.
- **Muted Zinc** (#71717A) - Disabled, timestamps, placeholders, and low-priority text.
- **SPT Red** (#FF3B30) - Single accent for primary actions, current page, live/active state, focus rings, and critical PBX status.
- **Light Canvas** (#F4F4F5) - Light-theme application canvas.
- **Light Surface** (#FFFFFF) - Light-theme panels and input surfaces.

Maximum accent count is one: SPT Red. Preserve the existing black, zinc, white, and red theme.

## 3. Typography Rules

- **UI Sans:** Roboto for English interface text. Use consistent weights from 400 to 900 without display-font decoration.
- **Arabic Sans:** IBM Plex Sans Arabic for Arabic and RTL interface text.
- **Mono:** JetBrains Mono, SF Mono, or system monospace for extension numbers, timers, timestamps, call IDs, and compact numeric data.
- **Scale:** Product UI uses fixed rem sizes, not fluid hero typography. Headings stay controlled at 1.5rem to 1.875rem. Table labels stay compact but readable.
- **Banned:** Serif fonts, gradient text, decorative display faces, and typography that makes labels harder to scan.

## 4. Component Stylings

* **Buttons:** Flat, high-contrast surfaces with SPT Red for primary actions. Active feedback is a small translate or darker fill, not glow. Disabled states must clearly reduce contrast and remove pointer affordance.
* **Cards and Panels:** Use 12px to 16px radii. Panels can have a crisp border or a small shadow, but not heavy decorative elevation. Metric cards should communicate category through labels and hierarchy, not thick side stripes.
* **Inputs:** Label above input, 44px minimum touch target, clear focus ring in SPT Red, readable placeholder contrast, no floating labels.
* **Tables:** Sticky headers where useful, tabular numerals, strong row hover, consistent padding, and empty states that explain the lack of data.
* **Navigation:** Shared top navigation keeps the logo, current page indicator, theme/language/settings controls, and horizontal scrolling on narrow screens without page overflow.
* **Modals and Toasts:** Use the existing dark surfaces, concise copy, visible close controls, and focused action rows.
* **Loaders:** Prefer layout-sized skeletons for larger data areas. Small spinners are acceptable only inside already-framed panels during async refresh.

## 5. Layout Principles

Use a restrained app-shell layout with max-width-free operational content because tables and switchboards need room. Maintain consistent 1rem to 2rem page padding, collapse side-by-side panels below tablet widths, and prevent horizontal page overflow. Mobile views should keep navigation usable through contained horizontal scrolling while main content stacks vertically.

## 6. Motion & Interaction

Transitions run 150ms to 220ms using ease-out curves. Motion communicates hover, focus, active state, modal entry, toast entry, and live call/ringing state. Avoid page-load choreography and elastic animation. Respect `prefers-reduced-motion: reduce` by disabling transform-heavy transitions and repeating pulse effects.

## 7. Anti-Patterns (Banned)

No backend behavior changes for UI polish. No new theme colors, no neon glows, no pure black replacement palettes, no gradient text, no decorative side-stripe card borders, no oversized rounded cards, no custom cursors, no decorative page-load animations, no generic SaaS copy such as "Elevate" or "Next-Gen", no inconsistent button shapes, no unreadable placeholder text, and no horizontal page overflow on mobile.
