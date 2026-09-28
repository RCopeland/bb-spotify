import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SPOTIFY_SCOPES,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  formatDevices,
  formatDuration,
  formatPlayback,
  getAvailableDevices,
  getCurrentPlayback,
  parseAuthorizationInput,
  parseSpotifyApiError,
  refreshAccessToken,
  resolveDevice,
  saveTrackToLibrary,
  searchTracks,
  spotifyRequest,
  startPlayback,
  type PendingAuthSession,
  type SpotifyDevice,
} from "./src/spotify";

const pendingAuthSchema = z
  .object({
    state: z.string(),
    createdAt: z.string(),
    redirectUri: z.string().url(),
    code: z.string().optional(),
    callbackUrl: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const controlActionSchema = z.enum(["pause", "play", "next", "previous"]);

const sidebarDeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    isActive: z.boolean(),
    isRestricted: z.boolean(),
    volumePercent: z.number().int().min(0).max(100).nullable(),
  })
  .strict();

const sidebarPlaybackSchema = z
  .object({
    summary: z.string(),
    isPlaying: z.boolean(),
    deviceName: z.string().nullable(),
    trackName: z.string().nullable(),
    trackUri: z.string().nullable(),
    artistNames: z.array(z.string()),
    albumName: z.string().nullable(),
    progressLabel: z.string().nullable(),
  })
  .strict();

const sidebarSearchTrackSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    artistNames: z.array(z.string()),
    albumName: z.string().nullable(),
    durationLabel: z.string(),
  })
  .strict();

const sidebarStateSchema = z
  .object({
    connected: z.boolean(),
    clientIdConfigured: z.boolean(),
    clientSecretConfigured: z.boolean(),
    refreshTokenConfigured: z.boolean(),
    defaultDeviceId: z.string().nullable(),
    allowDisruptiveActions: z.boolean(),
    redirectUri: z.string(),
    pendingAuth: z
      .object({
        createdAt: z.string(),
        callbackReceived: z.boolean(),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    playback: sidebarPlaybackSchema.nullable(),
    devices: z.array(sidebarDeviceSchema),
    connectionError: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  sidebar_get_state: {
    input: z.null(),
    output: sidebarStateSchema,
  },
  sidebar_control: {
    input: z
      .object({
        action: controlActionSchema,
      })
      .strict(),
    output: z
      .object({
        message: z.string(),
      })
      .strict(),
  },
  sidebar_transfer: {
    input: z
      .object({
        deviceId: z.string().min(1),
        play: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        message: z.string(),
      })
      .strict(),
  },
  sidebar_search: {
    input: z
      .object({
        query: z.string().trim().min(1).max(200),
      })
      .strict(),
    output: z
      .object({
        results: z.array(sidebarSearchTrackSchema),
      })
      .strict(),
  },
  sidebar_play_track: {
    input: z
      .object({
        uri: z.string().min(1),
        deviceId: z.string().trim().optional(),
      })
      .strict(),
    output: z
      .object({
        message: z.string(),
      })
      .strict(),
  },
  sidebar_like_current_track: {
    input: z.null(),
    output: z
      .object({
        message: z.string(),
      })
      .strict(),
  },
});

function jsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function maskSecret(value: string | undefined): string {
  return value ? "set" : "missing";
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function success(text: string) {
  return { exitCode: 0, stdout: `${text}\n` };
}

function failure(text: string) {
  return { exitCode: 1, stderr: `${text}\n` };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clientId: {
      type: "string",
      label: "Spotify client ID",
      default: "",
    },
    clientSecret: {
      type: "string",
      label: "Spotify client secret",
      secret: true,
    },
    refreshToken: {
      type: "string",
      label: "Spotify refresh token",
      secret: true,
    },
    defaultDeviceId: {
      type: "string",
      label: "Default Spotify device ID",
      default: "",
    },
    allowDisruptiveActions: {
      type: "boolean",
      label: "Allow agents to start/resume playback",
      default: false,
    },
  });

  async function getRedirectUri(): Promise<string> {
    const appUrl = bb.server.experimental_appUrl;
    const baseUrl = normalizeBaseUrl(appUrl ?? bb.server.loopbackBaseUrl);
    return `${baseUrl}/api/v1/plugins/${bb.pluginId}/http/oauth/callback`;
  }

  async function getPendingAuth(): Promise<PendingAuthSession | null> {
    const value = await bb.storage.kv.get<PendingAuthSession>("pending-auth");
    if (value == null) return null;
    return pendingAuthSchema.parse(value);
  }

  async function setPendingAuth(session: PendingAuthSession | null): Promise<void> {
    if (session === null) {
      await bb.storage.kv.delete("pending-auth");
      return;
    }
    await bb.storage.kv.set("pending-auth", pendingAuthSchema.parse(session));
  }

  async function requireConfiguredApp(): Promise<{
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    defaultDeviceId: string;
    allowDisruptiveActions: boolean;
  }> {
    const current = await settings.get();
    const clientId = current.clientId.trim();
    if (!clientId) {
      throw new Error("Spotify client ID is missing. Set your own Spotify app's client ID in BB plugin settings or with `bb plugin config spotify set clientId <id>`.");
    }
    if (!current.clientSecret) {
      throw new Error("Spotify client secret is missing. Set your own Spotify app's client secret in BB plugin settings before starting auth.");
    }
    return {
      clientId,
      clientSecret: current.clientSecret,
      refreshToken: current.refreshToken,
      defaultDeviceId: current.defaultDeviceId,
      allowDisruptiveActions: current.allowDisruptiveActions,
    };
  }

  async function getAccessToken(): Promise<string> {
    const current = await requireConfiguredApp();
    if (!current.refreshToken) {
      throw new Error("Spotify is not connected yet. Run `bb spotify auth start` first.");
    }

    const token = await refreshAccessToken({
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      refreshToken: current.refreshToken,
    });

    if (token.refreshToken && token.refreshToken !== current.refreshToken) {
      await settings.experimental_set({ refreshToken: token.refreshToken });
    }

    return token.accessToken;
  }

  async function getDevices(): Promise<SpotifyDevice[]> {
    const accessToken = await getAccessToken();
    return getAvailableDevices(accessToken);
  }

  async function getPlaybackSummary(): Promise<string> {
    const accessToken = await getAccessToken();
    const playback = await getCurrentPlayback(accessToken);
    return formatPlayback(playback);
  }

  async function getSidebarState() {
    const current = await settings.get();
    const pendingAuth = await getPendingAuth();
    const baseState = {
      connected: Boolean(current.refreshToken),
      clientIdConfigured: current.clientId.trim().length > 0,
      clientSecretConfigured: Boolean(current.clientSecret),
      refreshTokenConfigured: Boolean(current.refreshToken),
      defaultDeviceId: current.defaultDeviceId.trim() || null,
      allowDisruptiveActions: current.allowDisruptiveActions,
      redirectUri: await getRedirectUri(),
      pendingAuth: pendingAuth
        ? {
            createdAt: pendingAuth.createdAt,
            callbackReceived: Boolean(pendingAuth.code),
            error: pendingAuth.error ?? null,
          }
        : null,
      playback: null,
      devices: [] as Array<z.infer<typeof sidebarDeviceSchema>>,
      connectionError: null as string | null,
    };

    if (!current.clientId.trim() || !current.clientSecret || !current.refreshToken) {
      return baseState;
    }

    try {
      const accessToken = await getAccessToken();
      const [playback, devices] = await Promise.all([
        getCurrentPlayback(accessToken),
        getAvailableDevices(accessToken),
      ]);

      return {
        ...baseState,
        playback: playback
          ? {
              summary: formatPlayback(playback),
              isPlaying: Boolean(playback.is_playing),
              deviceName: playback.device?.name ?? null,
              trackName: playback.item?.name ?? null,
              trackUri: playback.item?.uri ?? null,
              artistNames: playback.item?.artists?.map((artist) => artist.name) ?? [],
              albumName: playback.item?.album?.name ?? null,
              progressLabel:
                typeof playback.progress_ms === "number" && typeof playback.item?.duration_ms === "number"
                  ? `${Math.floor(playback.progress_ms / 1000)}s / ${Math.floor(playback.item.duration_ms / 1000)}s`
                  : null,
            }
          : null,
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          type: device.type,
          isActive: device.is_active,
          isRestricted: device.is_restricted,
          volumePercent: device.volume_percent,
        })),
      };
    } catch (error) {
      return {
        ...baseState,
        connectionError: parseSpotifyApiError(error),
      };
    }
  }

  async function controlPlayback(action: z.infer<typeof controlActionSchema>, deviceId?: string): Promise<string> {
    const accessToken = await getAccessToken();
    const current = await settings.get();
    const targetDeviceId = deviceId?.trim() || current.defaultDeviceId.trim() || undefined;

    switch (action) {
      case "pause": {
        await spotifyRequest("PUT", "/me/player/pause", {
          accessToken,
          query: targetDeviceId ? { device_id: targetDeviceId } : undefined,
        });
        return targetDeviceId ? `Paused playback on ${targetDeviceId}.` : "Paused playback.";
      }
      case "play": {
        await spotifyRequest("PUT", "/me/player/play", {
          accessToken,
          query: targetDeviceId ? { device_id: targetDeviceId } : undefined,
        });
        return targetDeviceId ? `Resumed playback on ${targetDeviceId}.` : "Resumed playback.";
      }
      case "next": {
        await spotifyRequest("POST", "/me/player/next", {
          accessToken,
          query: targetDeviceId ? { device_id: targetDeviceId } : undefined,
        });
        return targetDeviceId ? `Skipped to the next track on ${targetDeviceId}.` : "Skipped to the next track.";
      }
      case "previous": {
        await spotifyRequest("POST", "/me/player/previous", {
          accessToken,
          query: targetDeviceId ? { device_id: targetDeviceId } : undefined,
        });
        return targetDeviceId ? `Went back to the previous track on ${targetDeviceId}.` : "Went back to the previous track.";
      }
    }
  }

  async function transferPlayback(deviceSpecifier: string, play = false): Promise<string> {
    const accessToken = await getAccessToken();
    const devices = await getAvailableDevices(accessToken);
    const device = resolveDevice(devices, deviceSpecifier);
    await spotifyRequest("PUT", "/me/player", {
      accessToken,
      body: { device_ids: [device.id], play },
    });
    return play
      ? `Transferred playback to ${device.name} and started playing.`
      : `Transferred playback to ${device.name}.`;
  }

  async function searchTrackResults(query: string) {
    const accessToken = await getAccessToken();
    const results = await searchTracks(accessToken, query, 8);
    return results.map((track) => ({
      uri: track.uri,
      name: track.name,
      artistNames: track.artists.map((artist) => artist.name),
      albumName: track.album?.name ?? null,
      durationLabel: formatDuration(track.duration_ms),
    }));
  }

  async function playTrack(uri: string, deviceId?: string): Promise<string> {
    const accessToken = await getAccessToken();
    const current = await settings.get();
    const targetDeviceId = deviceId?.trim() || current.defaultDeviceId.trim() || undefined;
    await startPlayback(accessToken, { uri, deviceId: targetDeviceId });
    return targetDeviceId
      ? `Started playback on ${targetDeviceId}.`
      : "Started playback.";
  }

  async function likeCurrentTrack(): Promise<string> {
    const accessToken = await getAccessToken();
    const playback = await getCurrentPlayback(accessToken);
    const trackName = playback?.item?.name;
    const trackUri = playback?.item?.uri;
    if (!trackName || !trackUri) {
      throw new Error("No playable track is active, so there is nothing to save to Liked Songs.");
    }
    await saveTrackToLibrary(accessToken, trackUri);
    return `Saved ${trackName} to Liked Songs.`;
  }

  bb.rpc.register(rpcContract, {
    sidebar_get_state: async () => await getSidebarState(),
    sidebar_control: async ({ action }) => ({
      message: await controlPlayback(action),
    }),
    sidebar_transfer: async ({ deviceId, play }) => ({
      message: await transferPlayback(deviceId, play),
    }),
    sidebar_search: async ({ query }) => ({
      results: await searchTrackResults(query),
    }),
    sidebar_play_track: async ({ uri, deviceId }) => ({
      message: await playTrack(uri, deviceId),
    }),
    sidebar_like_current_track: async () => ({
      message: await likeCurrentTrack(),
    }),
  });

  bb.http.route("GET", "/oauth/callback", async (context) => {
    const code = context.req.query("code");
    const state = context.req.query("state");
    const error = context.req.query("error") ?? context.req.query("error_description");
    const redirectUri = await getRedirectUri();
    const pending = await getPendingAuth();

    if (!pending) {
      return new Response(
        "Spotify auth callback received, but there is no pending auth session in BB. You can close this tab.",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (state !== pending.state) {
      await setPendingAuth({
        ...pending,
        error: "State mismatch. Start auth again from `bb spotify auth start`.",
      });
      return new Response("Spotify auth state mismatch. Return to BB and run auth again.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    await setPendingAuth({
      state: pending.state,
      createdAt: pending.createdAt,
      redirectUri,
      code: code ?? undefined,
      callbackUrl: context.req.url,
      error: error ?? undefined,
    });

    return new Response(
      "Spotify authorization received. Return to BB and run `bb spotify auth finish`.",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  });

  bb.agents.registerTool({
    name: "spotify_get_playback",
    description: "Get the current Spotify playback summary for the connected account.",
    instructions: "Use this to check what is currently playing before changing playback.",
    parameters: z.object({}).strict(),
    async execute() {
      return await getPlaybackSummary();
    },
  });

  bb.agents.registerTool({
    name: "spotify_list_devices",
    description: "List available Spotify Connect devices for the connected account.",
    parameters: z.object({}).strict(),
    async execute() {
      const devices = await getDevices();
      return devices.length === 0 ? "No Spotify devices are available." : formatDevices(devices);
    },
  });

  bb.agents.registerTool({
    name: "spotify_control",
    description: "Control Spotify transport. Safe by default: play is blocked unless plugin settings allow disruptive actions.",
    instructions: "Prefer status checks first. Do not resume playback unless the user asked for it or the plugin allows it.",
    parameters: z
      .object({
        action: controlActionSchema,
        deviceId: z.string().trim().optional(),
      })
      .strict(),
    async execute({ action, deviceId }) {
      const current = await settings.get();
      if (action === "play" && !current.allowDisruptiveActions) {
        return "Play/resume is disabled for agents. Turn on 'Allow agents to start/resume playback' in plugin settings if you want that.";
      }
      return await controlPlayback(action, deviceId);
    },
  });

  bb.agents.configure(() => ({
    tools: ["spotify_get_playback", "spotify_list_devices", "spotify_control"],
    skills: ["spotify-control"],
  }));

  const usage = [
    "Usage:",
    "  bb spotify setup",
    "  bb spotify auth start",
    "  bb spotify auth status",
    "  bb spotify auth finish [<redirect-url-or-code>]",
    "  bb spotify status [--json]",
    "  bb spotify devices [--json]",
    "  bb spotify search <query> [--json]",
    "  bb spotify pause",
    "  bb spotify play",
    "  bb spotify next",
    "  bb spotify previous",
    "  bb spotify transfer <device-id-or-name> [--play]",
  ].join("\n");

  bb.cli.register({
    name: "spotify",
    summary: "Control Spotify playback from BB",
    commands: [
      { name: "setup", summary: "Show setup details and redirect URI", usage: "bb spotify setup" },
      { name: "auth", summary: "Start or complete Spotify OAuth", usage: "bb spotify auth <start|status|finish> [value]" },
      { name: "status", summary: "Show current playback", usage: "bb spotify status [--json]" },
      { name: "devices", summary: "List Spotify devices", usage: "bb spotify devices [--json]" },
      { name: "search", summary: "Search Spotify tracks", usage: "bb spotify search <query> [--json]" },
      { name: "pause", summary: "Pause playback", usage: "bb spotify pause" },
      { name: "play", summary: "Resume playback", usage: "bb spotify play" },
      { name: "next", summary: "Skip to the next track", usage: "bb spotify next" },
      { name: "previous", summary: "Go back to the previous track", usage: "bb spotify previous" },
      { name: "transfer", summary: "Transfer playback to a device", usage: "bb spotify transfer <device-id-or-name> [--play]" },
    ],
    async run(argv) {
      try {
        const json = argv.includes("--json");
        const play = argv.includes("--play");
        const filtered = argv.filter((arg) => arg !== "--json" && arg !== "--play");
        const [command, subcommand, ...args] = filtered;

        if (!command || command === "help" || command === "--help") {
          return success(usage);
        }

        if (command === "setup") {
          const current = await settings.get();
          const redirectUri = await getRedirectUri();
          const lines = [
            "Spotify plugin setup",
            `- Redirect URI: ${redirectUri}`,
            `- Client ID: ${current.clientId.trim() ? "set" : "missing"}`,
            `- Client secret: ${maskSecret(current.clientSecret)}`,
            `- Refresh token: ${maskSecret(current.refreshToken)}`,
            `- Default device ID: ${current.defaultDeviceId.trim() || "not set"}`,
            `- Agent play/resume allowed: ${current.allowDisruptiveActions ? "yes" : "no"}`,
            `- OAuth scopes: ${SPOTIFY_SCOPES.join(", ")}`,
            "",
            current.refreshToken
              ? "If you added new features that need new scopes, run `bb spotify auth start` and `bb spotify auth finish` again to refresh consent."
              : "",
            "Next:",
            "1. Create your own Spotify developer app.",
            "2. Add the redirect URI above to that app.",
            "3. Set that app's client ID and secret in your own BB plugin settings.",
            "4. Run `bb spotify auth start`.",
            "",
            "This plugin does not include a shared Spotify app.",
          ];
          return success(lines.join("\n"));
        }

        if (command === "auth") {
          switch (subcommand) {
            case "start": {
              const current = await requireConfiguredApp();
              const redirectUri = await getRedirectUri();
              const pending: PendingAuthSession = {
                state: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                redirectUri,
              };
              await setPendingAuth(pending);
              const url = buildAuthorizationUrl({
                clientId: current.clientId,
                redirectUri,
                state: pending.state,
                scopes: SPOTIFY_SCOPES,
              });
              return success([
                "Open this URL in a browser and approve Spotify access:",
                url,
                "",
                `Redirect URI registered in your Spotify app settings must be: ${redirectUri}`,
                "After approval, if the callback page says it was received, run `bb spotify auth finish`.",
                "If the callback does not reach BB, copy the full redirect URL from your browser and run:",
                "bb spotify auth finish '<full redirect url>'",
              ].join("\n"));
            }
            case "status": {
              const pending = await getPendingAuth();
              if (!pending) return success("No pending Spotify auth session.");
              return success([
                "Pending Spotify auth session:",
                `- Created: ${pending.createdAt}`,
                `- Redirect URI: ${pending.redirectUri}`,
                `- Callback received: ${pending.code ? "yes" : "no"}`,
                `- Error: ${pending.error ?? "none"}`,
              ].join("\n"));
            }
            case "finish": {
              const current = await requireConfiguredApp();
              const pending = await getPendingAuth();
              const manualValue = args.join(" ").trim();
              if (!pending && !manualValue) {
                return failure("No pending auth session. Run `bb spotify auth start` first.");
              }
              const parsed = parseAuthorizationInput(manualValue || pending?.callbackUrl || pending?.code || "");
              if (pending?.state && parsed.state && parsed.state !== pending.state) {
                return failure("Auth state mismatch. Run `bb spotify auth start` again.");
              }
              if (!parsed.code) {
                return failure("No authorization code found. Run `bb spotify auth status` or pass the redirect URL explicitly.");
              }
              const redirectUri = pending?.redirectUri ?? (await getRedirectUri());
              const token = await exchangeAuthorizationCode({
                clientId: current.clientId,
                clientSecret: current.clientSecret,
                redirectUri,
                code: parsed.code,
              });
              await settings.experimental_set({ refreshToken: token.refreshToken });
              await setPendingAuth(null);
              return success("Spotify connection saved. You can now run `bb spotify status` or `bb spotify devices`.");
            }
            default:
              return failure(usage);
          }
        }

        if (command === "status") {
          const accessToken = await getAccessToken();
          const playback = await getCurrentPlayback(accessToken);
          return {
            exitCode: 0,
            stdout: json ? jsonStringify(playback) : `${formatPlayback(playback)}\n`,
          };
        }

        if (command === "devices") {
          const devices = await getDevices();
          return {
            exitCode: 0,
            stdout: json ? jsonStringify(devices) : `${formatDevices(devices)}\n`,
          };
        }

        if (command === "search") {
          const query = [subcommand, ...args].join(" ").trim();
          if (!query) return failure("Usage: bb spotify search <query> [--json]");
          const results = await searchTrackResults(query);
          return {
            exitCode: 0,
            stdout: json
              ? jsonStringify(results)
              : `${results.length === 0 ? "No tracks found." : results.map((track) => `${track.uri}  ${track.artistNames.join(", ")} — ${track.name}${track.albumName ? ` — ${track.albumName}` : ""} (${track.durationLabel})`).join("\n")}\n`,
          };
        }

        if (command === "pause" || command === "play" || command === "next") {
          return success(await controlPlayback(command, args[0]));
        }

        if (command === "previous") {
          return success(await controlPlayback("previous", args[0]));
        }

        if (command === "transfer") {
          const deviceSpecifier = [subcommand, ...args].join(" ").trim();
          if (!deviceSpecifier) return failure("Usage: bb spotify transfer <device-id-or-name> [--play]");
          return success(await transferPlayback(deviceSpecifier, play));
        }

        return failure(usage);
      } catch (error) {
        const message = parseSpotifyApiError(error);
        bb.log.error(`spotify command failed: ${message}`);
        return failure(message);
      }
    },
  });
}
