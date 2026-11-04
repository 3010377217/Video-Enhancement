# 帧序 Design

## Scene
A Windows user reviews anime footage in a desktop editor in subdued ambient light. A dark, cool-gray interface reduces surrounding luminance and keeps the video queue and export configuration visually primary, following the requested Jianying reference.

## Color
Restrained cool neutrals and one mint accent. CSS tokens use OKLCH. Background approximately #14171b; panels #1b1e23; raised controls #272b31; accent approximately #6cddd2. Accent is reserved for primary actions, selected choices, and small state indicators.

## Type
Segoe UI Variable / Segoe UI and Microsoft YaHei UI, system sans fallback. UI text 12–14px, section titles 15–18px, numeric data tabular. No display typography.

## Layout
56px application header, two-column workspace with a flexible video queue and a 326px export inspector, plus a persistent bottom action bar. Main padding 24px, 20px inter-panel gap. The queue uses the available workspace height while video rows retain compact content-driven sizing. At narrow widths, inspector follows the queue. No footage preview panel, decorative card grid, or left navigation rail.

## Components
Video table with four business columns and bulk-select checkboxes. Compact text/icon buttons, 6px control radii, 8px panel radii, 1px separators, no large shadows. Native selects retain keyboard behavior. Long text truncates with full titles available. Use Radix SVG icons, never emoji or typographic icon substitutes.

Processing strategy is a content-sized two-option segmented control in picture settings, with copy describing processing time and detail retention. Output control is an independent fieldset in encoding settings with three compact native radio choices and only the active numeric input. Never hide output methods behind a custom strategy or infer file size from processing speed. Number inputs are 84–96px wide with explicit units, visible range guidance, and inline validation. Settings scroll independently while the bottom action remains visible. Submitted tasks freeze their effective configuration; later edits apply to future submissions.

## Motion
No automatic or decorative animation. 150ms color feedback for hover/focus, opacity for notifications. Respect prefers-reduced-motion. Processing visuals use actual worker stages and progress. Pause means finishing the current task before starting the next.
