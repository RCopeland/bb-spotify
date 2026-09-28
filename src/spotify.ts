export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "user-library-modify",
] as const;

const ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
const API_BASE_URL = "https://api.spotify.com/v1";

export type PendingAuthSession = {
  state: string;
  createdAt: string;
  redirectUri: string;
  code?: string;
  callbackUrl?: string;
  error?: string;
};

export type SpotifyTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  tokenType: string;
};

export type SpotifyDevice = {
  id: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
};

export type SpotifyTrack = {
  uri?: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album?: { name: string };
};

export type SpotifySearchTrack = {
  uri: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album?: { name: string };
};

export type SpotifyPlaybackState = {
  device?: SpotifyDevice;
  repeat_state?: string;
  shuffle_state?: boolean;
  is_playing?: boolean;
  progress_ms?: number;
  currently_playing_type?: string;
  item?: SpotifyTrack | null;
};

function formUrlEncode(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function toBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

async function readSpotifyError(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    try {
      payload = await response.text();
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      const status = (error as { status?: unknown }).status;
      if (typeof message === "string") {
        return typeof status === "number"
          ? `Spotify API error ${status}: ${message}`
          : `Spotify API error: ${message}`;
      }
    }
  }

  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `Spotify request failed with HTTP ${response.status}.`;
}

export function parseSpotifyApiError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown Spotify error.";
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}): string {
  const url = new URL(`${ACCOUNTS_BASE_URL}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function parseAuthorizationInput(value: string): { code?: string; state?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    return { code: trimmed };
  }
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<SpotifyTokenResponse> {
  const response = await fetch(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${toBasicAuth(input.clientId, input.clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formUrlEncode({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  if (!json.refresh_token) {
    throw new Error("Spotify did not return a refresh token.");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SpotifyTokenResponse> {
  const response = await fetch(`${ACCOUNTS_BASE_URL}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${toBasicAuth(input.clientId, input.clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formUrlEncode({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    token_type: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export async function spotifyRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: {
    accessToken: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
  },
): Promise<Response> {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  return response;
}

export async function getCurrentPlayback(accessToken: string): Promise<SpotifyPlaybackState | null> {
  const response = await fetch(`${API_BASE_URL}/me/player`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(await readSpotifyError(response));
  }

  return (await response.json()) as SpotifyPlaybackState;
}

export async function getAvailableDevices(accessToken: string): Promise<SpotifyDevice[]> {
  const response = await spotifyRequest("GET", "/me/player/devices", { accessToken });
  const json = (await response.json()) as { devices?: SpotifyDevice[] };
  return json.devices ?? [];
}

export function resolveDevice(devices: SpotifyDevice[], specifier: string): SpotifyDevice {
  const normalized = specifier.trim().toLowerCase();
  const exactId = devices.find((device) => device.id === specifier.trim());
  if (exactId) return exactId;

  const exactName = devices.filter((device) => device.name.trim().toLowerCase() === normalized);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) {
    throw new Error(`More than one Spotify device is named \"${specifier}\". Use the device ID instead.`);
  }

  const partialName = devices.filter((device) => device.name.toLowerCase().includes(normalized));
  if (partialName.length === 1) return partialName[0];
  if (partialName.length > 1) {
    throw new Error(`Several Spotify devices match \"${specifier}\". Run \`bb spotify devices\` and use a device ID.`);
  }

  throw new Error(`No Spotify device matched \"${specifier}\".`);
}

export function formatDuration(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds < 0) return "0:00";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatPlayback(playback: SpotifyPlaybackState | null): string {
  if (!playback) return "Nothing is currently playing.";

  const item = playback.item;
  const artists = item?.artists?.map((artist) => artist.name).join(", ") || "Unknown artist";
  const track = item?.name ?? "Unknown track";
  const album = item?.album?.name ? ` — ${item.album.name}` : "";
  const device = playback.device?.name ? ` on ${playback.device.name}` : "";
  const progress = `${formatDuration(playback.progress_ms)} / ${formatDuration(item?.duration_ms)}`;
  const state = playback.is_playing ? "Playing" : "Paused";
  return `${state}: ${artists} — ${track}${album}${device} (${progress})`;
}

export function formatDevices(devices: SpotifyDevice[]): string {
  if (devices.length === 0) return "No Spotify devices are available.";
  return devices
    .map((device) => {
      const flags = [device.is_active ? "active" : null, device.is_restricted ? "restricted" : null]
        .filter(Boolean)
        .join(", ");
      const suffix = flags ? ` [${flags}]` : "";
      const volume = device.volume_percent === null ? "n/a" : `${device.volume_percent}%`;
      return `${device.id}  ${device.name} (${device.type}, volume ${volume})${suffix}`;
    })
    .join("\n");
}

export async function searchTracks(accessToken: string, query: string, limit = 8): Promise<SpotifySearchTrack[]> {
  const response = await spotifyRequest("GET", "/search", {
    accessToken,
    query: {
      q: query,
      type: "track",
      limit: String(limit),
    },
  });
  const json = (await response.json()) as { tracks?: { items?: SpotifySearchTrack[] } };
  return json.tracks?.items ?? [];
}

export async function startPlayback(accessToken: string, input: { uri: string; deviceId?: string }): Promise<void> {
  await spotifyRequest("PUT", "/me/player/play", {
    accessToken,
    query: input.deviceId ? { device_id: input.deviceId } : undefined,
    body: { uris: [input.uri] },
  });
}

export async function saveTrackToLibrary(accessToken: string, trackUri: string): Promise<void> {
  await spotifyRequest("PUT", "/me/library", {
    accessToken,
    query: { uris: trackUri },
  });
}
