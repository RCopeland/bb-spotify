# bb-plugin-spotify

A headless BB plugin that connects BB to Spotify so you can inspect playback, list devices, and control transport from:

- `bb spotify ...` CLI commands
- native BB agent tools
- a local OAuth callback handled by the plugin itself

## Current MVP

This first version supports:

- setup help and callback URL generation
- Spotify OAuth start/status/finish flow
- secure storage of the Spotify refresh token in plugin settings
- current playback status
- available device listing
- transport controls: pause, play, next, previous
- transfer playback to another device
- agent tools for status, device listing, and safe transport control

It is intentionally **headless** for now: no sidebar panel yet.

## Requirements

- BB `>= 0.42`
- Your own Spotify developer app
- A Spotify account that can authorize that app

This plugin does **not** ship with a shared Spotify app. Each user must create and configure their own Spotify developer app and keep its client secret in their own BB settings.
- **Spotify Premium for playback-control endpoints** like pause, play, skip, and transfer

## Install

From this repository:

```bash
npm install
bb plugin install .
```

After changes:

```bash
bb plugin reload spotify
```

## Setup

First, ask the plugin for the exact callback URL your Spotify app must allow:

```bash
bb spotify setup
```

Then:

1. Create your own Spotify developer app.
2. Add the redirect URI printed by `bb spotify setup`.
3. Set that app's client ID and client secret in your own BB plugin settings.
4. Run the auth flow.

### Configure settings

The safest way to set secrets is through BB's plugin settings UI.

You can also inspect current values from the CLI:

```bash
bb plugin config spotify
```

And set non-secret values from the CLI if you want:

```bash
bb plugin config spotify set clientId <spotify-client-id>
bb plugin config spotify set defaultDeviceId <spotify-device-id>
```

For `clientSecret`, prefer the BB UI so it does not end up in shell history.

Do not share your Spotify app credentials with other users. If someone else installs this plugin, they should create their own app instead of reusing yours.

## OAuth flow

Start auth:

```bash
bb spotify auth start
```

That prints a Spotify authorization URL.

After you approve access in the browser, one of two things happens:

### Normal path

The browser hits the plugin callback URL and shows a confirmation message.

Then run:

```bash
bb spotify auth finish
```

### Fallback path

If the callback cannot reach BB, copy the full redirect URL from the browser and pass it manually:

```bash
bb spotify auth finish 'http://127.0.0.1:38886/api/v1/plugins/spotify/http/oauth/callback?code=...&state=...'
```

## Commands

```bash
bb spotify setup
bb spotify auth start
bb spotify auth status
bb spotify auth finish [<redirect-url-or-code>]
bb spotify status
bb spotify devices
bb spotify pause
bb spotify play
bb spotify next
bb spotify previous
bb spotify transfer <device-id-or-name> [--play]
```

Examples:

```bash
bb spotify status
bb spotify devices --json
bb spotify pause
bb spotify transfer "Office MacBook" --play
```

## Agent tools

The plugin registers these BB tools:

- `spotify_get_playback`
- `spotify_list_devices`
- `spotify_control`

By default, the tool will **not** resume playback unless `allowDisruptiveActions` is enabled in plugin settings.

## Notes

- The plugin refreshes short-lived Spotify access tokens automatically from the stored refresh token.
- Commands target the active device unless you pass a device ID or configure `defaultDeviceId`.
- The plugin can also save the currently playing track to **Liked Songs** from the mini player.
- This version does not yet support playlists or volume controls.

## Next likely additions

- search and play by track/album/playlist
- a now-playing BB panel
- volume and shuffle controls
- optional host-local fallback control for the desktop Spotify app
