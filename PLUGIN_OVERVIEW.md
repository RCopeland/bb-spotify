Control Spotify from BB with a focused, OAuth-backed command surface.

## What it does

This plugin connects BB to your Spotify account so you can:

- inspect what is currently playing
- list Spotify Connect devices
- pause, resume, skip, and go back
- transfer playback to another device
- let BB agents query playback or perform safe transport actions

## How it works

The plugin stores your Spotify client credentials and refresh token in BB plugin settings, then refreshes access tokens automatically when commands run. OAuth can complete through the plugin's own callback route or by pasting the final redirect URL back into BB.

The plugin does not include a shared Spotify app. Each user is expected to create and configure their own Spotify developer app and keep its client secret in their own BB settings.

## Current scope

This release is intentionally small and headless:

- `bb spotify ...` CLI
- native agent tools
- no sidebar panel yet

Playback control depends on Spotify's Web API and, for many player endpoints, requires Spotify Premium.
