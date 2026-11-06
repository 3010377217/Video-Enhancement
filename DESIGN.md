# 帧序 Design

## Vendor Perspective
Design and build as a software vendor shipping to many users, not for this development machine. Do not tie defaults, limits, or behavior to the local hardware or environment. Options must suit varied GPUs, VRAM, disks, and Windows setups; safe automatic defaults come first, and advanced values stay user-adjustable and validated.

## Scene
A Windows user queues local anime footage in a desktop editor in subdued light. A near-black interface with one cyan accent (reference: Jianying) keeps the queue and export settings primary.

## Color
Flat, no gradients, no shadows. Background #111113, panel #1a1a1d, controls #26262a (hover #2f2f34), separators #2a2a2f. Text #f2f2f3, secondary #a0a0a8, tertiary #74747c. Accent #00d6e0 is used only for the primary button, selected options, progress, and active status. Danger #ff6b6b, success #4cd9a0.

## Type
Segoe UI Variable / Segoe UI / Microsoft YaHei UI. 12–13px for UI text, 15px for panel titles. Numeric data uses tabular figures.

## Layout
44px header (logo and name only). Two columns: flexible video queue, 320px export settings panel. The start button is pinned to the bottom of the settings panel; there is no footer bar, stepper, help dialog, or navigation.

Queue: table with four columns (name, resolution, size, actions). Row actions: remove always; pause/resume while processing; open output and retry when finished. Status text and a thin progress bar appear under the name only while a task has state. Empty queue: one dashed drop area with a select button. Queue-level controls (pause after current, cancel current, stop queue) appear in the queue header only while tasks run.

Settings, top to bottom: processing strategy (speed / quality / custom; custom exposes Real-ESRGAN tile, thread count `-j` load:proc:save, frames per chunk, and intermediate quality; every option defaults to auto), output resolution and frame rate, encoding (H.264 / H.265), output method (dynamic / fixed) with its value input, output directory.

## Components
6px control radii, 10px for drop areas. Segmented controls for two-option choices, native selects for lists. Inline validation under the field. Long text truncates with the full value in the title attribute. Radix SVG icons only.

## Fixed defaults (not exposed)
AI enhancement, keep audio, keep aspect ratio, output name suffix `_增强`, numbered names on collision, saved to the chosen directory. Older saved settings are normalized on load; per-video overrides are no longer used.

## Motion
No decorative animation. 150ms color transitions. Respect prefers-reduced-motion. Progress reflects actual worker stages. Pause means finishing the current task before starting the next.
