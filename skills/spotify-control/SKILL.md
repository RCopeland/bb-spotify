---
name: spotify-control
description: Use the BB Spotify plugin to inspect playback, list devices, and perform safe transport controls.
---

# Spotify control

Use the native Spotify tools before shelling out.

## Available tools

- `spotify_get_playback` — check what is currently playing
- `spotify_list_devices` — list Spotify Connect devices
- `spotify_control` — control transport (`pause`, `play`, `next`, `previous`)

## Guidance

- Prefer checking playback status before changing it.
- Do not resume playback unless the user explicitly asked, or plugin settings allow disruptive actions.
- If device targeting matters, list devices first and use a device ID.
- If playback commands fail, suggest the user confirm Spotify Premium and an active Spotify device.
