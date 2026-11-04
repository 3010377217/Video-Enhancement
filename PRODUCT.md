# Product

## Register
product

## Users
Windows users enhancing local anime videos. They add several videos, configure output, and let a sequential queue run on their own GPU. The primary surface is a desktop workspace used for sustained media work, with source footage kept on the local machine.

## Product Purpose
Turn a Python video enhancement pipeline into an understandable visual workflow. A queue shows video name, file size, source resolution, and row actions. Users configure resolution, frame rate, enhancement, processing strategy, output control, codec, audio, naming, and output directory. Processing strategy offers speed or quality priority in picture settings. Independently, output control offers fixed video bitrate in Mbps, quality-based dynamic bitrate with CQ/CRF guidance, or a total MB-per-minute size budget in encoding settings. All three output methods are directly accessible, with no custom mode gate. Processing strategy does not select an output method, alter its values, or imply a particular file size. Fixed bitrate suggestions reflect resolution, fps, codec, and source metadata, including mixed queues. Global settings are the default, with per-video overrides. The desktop application now executes real local FFmpeg conversion, Real-ESRGAN enhancement, RIFE interpolation, and verified final compression. Queue records and settings persist across restarts.

The deliverable is a Windows Electron desktop application with its own native window and a double-clickable executable. Production runs load bundled local files without a browser or development server. Web preview is only an auxiliary developer tool.

## Brand Personality
Focused, precise, calm. Chinese-first UI. The user explicitly references CapCut/Jianying and requests cool colors and compact controls proportional to their contents.

## Anti-references
Oversized boxes containing short labels; marketing dashboards; decorative metric cards; gradients and glowing controls; unnecessary side navigation; emoji icons; technical engine options crowding the main workflow.

## Design Principles
1. The video queue and export settings are the primary workspace.
2. Width follows content. Long paths get space; short choices use compact controls.
3. One cool mint accent identifies actions and selections. Use restrained cool-gray surfaces.
4. Show real source metadata, task stages, progress, failures, and actual encoder selection. Samples must be explicitly imported from real files.
5. Preserve keyboard access, visible focus, semantic labels, and reduced-motion support.
