import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  type ExperimentalAppOverlayProps,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import type { rpcContract } from "./server";

type SidebarDevice = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
};

type SidebarPlayback = {
  summary: string;
  isPlaying: boolean;
  deviceName: string | null;
  trackName: string | null;
  trackUri: string | null;
  artistNames: string[];
  albumName: string | null;
  progressLabel: string | null;
};

type SidebarState = {
  connected: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  refreshTokenConfigured: boolean;
  defaultDeviceId: string | null;
  allowDisruptiveActions: boolean;
  redirectUri: string;
  pendingAuth: {
    createdAt: string;
    callbackReceived: boolean;
    error: string | null;
  } | null;
  playback: SidebarPlayback | null;
  devices: SidebarDevice[];
  connectionError: string | null;
};

type SearchTrack = {
  uri: string;
  name: string;
  artistNames: string[];
  albumName: string | null;
  durationLabel: string;
};

let isSearchPopupOpen = false;
const searchPopupListeners = new Set<(open: boolean) => void>();

function setSearchPopupOpen(open: boolean) {
  isSearchPopupOpen = open;
  for (const listener of searchPopupListeners) listener(open);
}

function toggleSearchPopup() {
  setSearchPopupOpen(!isSearchPopupOpen);
}

function subscribeSearchPopup(listener: (open: boolean) => void) {
  searchPopupListeners.add(listener);
  return () => {
    searchPopupListeners.delete(listener);
  };
}

function overlayCardClassName() {
  return "pointer-events-auto w-full bg-background text-foreground";
}

function disclosureClassName() {
  return "pointer-events-auto max-h-[72vh] w-full overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl";
}

function sectionClassName() {
  return "border-t border-border p-3";
}

function buttonClassName(kind: "primary" | "secondary" | "danger" = "secondary") {
  const base = "inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  if (kind === "primary") {
    return `${base} border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25`;
  }
  if (kind === "danger") {
    return `${base} border-rose-500/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25`;
  }
  return `${base} border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground`;
}

function iconButtonClassName() {
  return "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground";
}

function inputClassName() {
  return "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring";
}

function muted(message: string) {
  return <p className="text-xs text-muted-foreground">{message}</p>;
}

function playbackMessage(state: SidebarState | null) {
  if (!state) return "Loading Spotify…";
  if (state.pendingAuth?.error) return `Auth pending: ${state.pendingAuth.error}`;
  if (state.pendingAuth?.callbackReceived) return "Auth callback received. Run `bb spotify auth finish`.";
  if (state.pendingAuth) return "Auth is pending in your browser.";
  if (!state.clientIdConfigured || !state.clientSecretConfigured) return "Set your own Spotify app credentials first.";
  if (!state.refreshTokenConfigured) return "Run `bb spotify auth start` to connect Spotify.";
  if (state.connectionError) return state.connectionError;
  if (state.playback) {
    return state.playback.deviceName ? `On ${state.playback.deviceName}` : "Playback active";
  }
  return state.devices.length > 0 ? "Connected. No active playback." : "Connected. No Spotify devices are available.";
}

function useSpotifyState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<SidebarState | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadingState(true);
    setError(null);
    try {
      const nextState = await rpc.call("sidebar_get_state", null);
      setState(nextState as SidebarState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Spotify state.");
    } finally {
      setLoadingState(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runControl = useCallback(
    async (action: "pause" | "play" | "next" | "previous") => {
      setBusy(action);
      setError(null);
      setInfo(null);
      try {
        const response = await rpc.call("sidebar_control", { action });
        setInfo(response.message);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} playback.`);
      } finally {
        setBusy(null);
      }
    },
    [refresh, rpc],
  );

  const transfer = useCallback(
    async (deviceId: string) => {
      setBusy(`transfer:${deviceId}`);
      setError(null);
      setInfo(null);
      try {
        const response = await rpc.call("sidebar_transfer", { deviceId, play: false });
        setInfo(response.message);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to transfer playback.");
      } finally {
        setBusy(null);
      }
    },
    [refresh, rpc],
  );

  const playTrack = useCallback(
    async (uri: string) => {
      setBusy(`play:${uri}`);
      setError(null);
      setInfo(null);
      try {
        const response = await rpc.call("sidebar_play_track", { uri });
        setInfo(response.message);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start playback.");
      } finally {
        setBusy(null);
      }
    },
    [refresh, rpc],
  );

  const likeCurrentTrack = useCallback(async () => {
    setBusy("like-current-track");
    setError(null);
    setInfo(null);
    try {
      const response = await rpc.call("sidebar_like_current_track", null);
      setInfo(response.message);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the current track.");
    } finally {
      setBusy(null);
    }
  }, [refresh, rpc]);

  return {
    state,
    loadingState,
    busy,
    error,
    info,
    refresh,
    runControl,
    transfer,
    playTrack,
    likeCurrentTrack,
    setError,
    setInfo,
  };
}

function findInlinePlayerMount(): HTMLElement | null {
  const footerButton = document.querySelector<HTMLElement>(
    '[aria-label="Spotify Search"], [title="Spotify Search"]',
  );
  if (!footerButton) return null;

  const footerItem = footerButton.parentElement;
  const footerRow = footerItem?.parentElement;
  if (!footerRow || !footerRow.parentElement) return null;

  let mount = footerRow.parentElement.querySelector<HTMLElement>("[data-spotify-inline-player]");
  if (!mount) {
    mount = document.createElement("div");
    mount.setAttribute("data-spotify-inline-player", "true");
    mount.style.width = "100%";
    footerRow.parentElement.insertBefore(mount, footerRow);
  }
  return mount;
}

function SpotifyMiniPlayer(_props: ExperimentalAppOverlayProps) {
  const { state, loadingState, busy, error, info, refresh, runControl, likeCurrentTrack } = useSpotifyState();
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const message = playbackMessage(state);
  const title = state?.playback?.trackName ?? "Spotify";
  const subtitle = state?.playback?.artistNames?.join(", ") || message;

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let ownedMount: HTMLElement | null = null;
    const interval = window.setInterval(() => {
      const nextMount = findInlinePlayerMount();
      if (nextMount) {
        ownedMount = nextMount;
        if (!cancelled) setMountNode(nextMount);
        window.clearInterval(interval);
      }
      attempts += 1;
      if (attempts > 40) {
        window.clearInterval(interval);
      }
    }, 250);

    const immediateMount = findInlinePlayerMount();
    if (immediateMount) {
      ownedMount = immediateMount;
      setMountNode(immediateMount);
      window.clearInterval(interval);
    }

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (ownedMount?.dataset.spotifyInlinePlayer === "true") {
        ownedMount.remove();
      }
    };
  }, []);

  const content = useMemo(
    () => (
      <div className={overlayCardClassName()}>
        <div className="border-t border-border px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{title}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
            <div className="flex items-center gap-1">
              <button className={iconButtonClassName()} onClick={toggleSearchPopup} title="Search Spotify" aria-label="Search Spotify">
                ⌕
              </button>
              <button className={iconButtonClassName()} onClick={() => void refresh()} disabled={loadingState || busy !== null} title="Refresh" aria-label="Refresh Spotify state">
                ↻
              </button>
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                className={buttonClassName()}
                onClick={() => void runControl("previous")}
                disabled={!state?.connected || loadingState || busy !== null}
                title="Previous"
                aria-label="Previous"
              >
                ⏮
              </button>
              <button
                className={buttonClassName()}
                onClick={() => void runControl(state?.playback?.isPlaying ? "pause" : "play")}
                disabled={!state?.connected || loadingState || busy !== null}
                title={state?.playback?.isPlaying ? "Pause" : "Play"}
                aria-label={state?.playback?.isPlaying ? "Pause" : "Play"}
              >
                {busy === "pause" || busy === "play" ? "…" : state?.playback?.isPlaying ? "⏸" : "▶"}
              </button>
              <button
                className={buttonClassName()}
                onClick={() => void runControl("next")}
                disabled={!state?.connected || loadingState || busy !== null}
                title="Next"
                aria-label="Next"
              >
                ⏭
              </button>
            </div>
            <button
              className={buttonClassName()}
              onClick={() => void likeCurrentTrack()}
              disabled={!state?.playback?.trackUri || loadingState || busy !== null}
              title="Save to Liked Songs"
              aria-label="Save current track to Liked Songs"
            >
              {busy === "like-current-track" ? "…" : "+"}
            </button>
          </div>

          <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
            <p className="truncate">{message}</p>
            <p>{state?.devices.length ? `${state.devices.length} device${state.devices.length === 1 ? "" : "s"} available` : "No devices available"}</p>
          </div>

          <div className="mt-2 min-h-[1.25rem] text-[11px] leading-5">
            {error ? (
              <p className="text-rose-500">{error}</p>
            ) : info ? (
              <p className="text-emerald-600">{info}</p>
            ) : (
              <p className="invisible">&nbsp;</p>
            )}
          </div>
        </div>
      </div>
    ),
    [busy, error, info, likeCurrentTrack, loadingState, message, refresh, runControl, state?.connected, state?.devices.length, state?.playback?.isPlaying, state?.playback?.trackUri, subtitle, title],
  );

  if (!mountNode) return null;
  return createPortal(content, mountNode);
}

function SpotifySearchPopup(_props: ExperimentalAppOverlayProps) {
  const { state, loadingState, busy, error, info, transfer, playTrack, setError, setInfo } = useSpotifyState();
  const rpc = useRpc<typeof rpcContract>();
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchTrack[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(isSearchPopupOpen);

  useEffect(() => subscribeSearchPopup(setOpen), []);

  const onSearch = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const query = searchQuery.trim();
      if (!query) {
        setResults([]);
        setHasSearched(false);
        return;
      }
      setHasSearched(true);
      setSearching(true);
      setError(null);
      setInfo(null);
      try {
        const response = await rpc.call("sidebar_search", { query });
        setResults(response.results as SearchTrack[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed.");
      } finally {
        setSearching(false);
      }
    },
    [rpc, searchQuery, setError, setInfo],
  );

  return open ? (
    <div className="pointer-events-none fixed bottom-[9.25rem] left-0 z-[95] hidden w-[var(--bb-sidebar-width,20rem)] max-w-[min(100vw,22rem)] px-2 lg:block">
      <div className={disclosureClassName()}>
        <div className="flex items-center justify-between gap-2 p-3">
          <div>
            <h2 className="text-sm font-semibold">Spotify search</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Find a track, play it, or transfer devices.</p>
          </div>
          <button className={iconButtonClassName()} onClick={() => setSearchPopupOpen(false)} title="Close" aria-label="Close search">
            ✕
          </button>
        </div>

        <div className="max-h-[calc(72vh-4rem)] overflow-y-auto">
          <section className={sectionClassName()}>
            <form className="flex gap-2" onSubmit={(event) => void onSearch(event)}>
              <input
                className={inputClassName()}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search Spotify tracks"
              />
              <button
                className={buttonClassName("primary")}
                type="submit"
                disabled={!state?.connected || searching || busy !== null || !searchQuery.trim()}
                title="Search"
                aria-label="Search"
              >
                {searching ? "…" : "⌕"}
              </button>
            </form>
            {!state?.connected ? <div className="mt-2">{muted("Connect Spotify before searching.")}</div> : null}
            {info ? <p className="mt-2 text-xs text-emerald-600">{info}</p> : null}
            {error ? <p className="mt-2 text-xs text-rose-500">{error}</p> : null}
            {state?.connected && hasSearched && !searching && results.length === 0 ? <div className="mt-2">{muted("No tracks found.")}</div> : null}
            <div className="mt-3 space-y-2">
              {results.map((track) => (
                <div key={track.uri} className="rounded-md border border-border px-2.5 py-2">
                  <p className="truncate text-sm font-medium">{track.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {track.artistNames.join(", ")}
                    {track.albumName ? ` — ${track.albumName}` : ""}
                    {` · ${track.durationLabel}`}
                  </p>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      className={buttonClassName("primary")}
                      onClick={() => void playTrack(track.uri)}
                      disabled={!state?.connected || busy !== null || searching}
                      title="Play track"
                      aria-label={`Play ${track.name}`}
                    >
                      {busy === `play:${track.uri}` ? "…" : "▶"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className={sectionClassName()}>
            <p className="text-sm font-medium">Devices</p>
            <div className="mt-2 space-y-2">
              {loadingState ? muted("Loading devices…") : null}
              {!loadingState && state?.devices.length === 0 ? muted("No Spotify devices are available right now.") : null}
              {state?.devices.map((device) => (
                <div key={device.id} className="rounded-md border border-border px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {device.name}
                        {device.isActive ? <span className="ml-1 text-emerald-500">●</span> : null}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {device.type} · vol {device.volumePercent ?? "n/a"}%
                      </p>
                    </div>
                    <button
                      className={buttonClassName()}
                      onClick={() => void transfer(device.id)}
                      disabled={loadingState || busy !== null || device.isActive || device.isRestricted}
                      title={device.isRestricted ? "Restricted" : device.isActive ? "Current device" : "Transfer playback"}
                      aria-label={device.isRestricted ? "Restricted device" : device.isActive ? `Current device ${device.name}` : `Transfer playback to ${device.name}`}
                    >
                      {busy === `transfer:${device.id}` ? "…" : device.isRestricted ? "🔒" : device.isActive ? "●" : "⇢"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  ) : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "spotify-mini-player",
    component: SpotifyMiniPlayer,
  });

  app.slots.experimental_appOverlay({
    id: "spotify-search-popup",
    component: SpotifySearchPopup,
  });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "spotify-search",
    label: "Spotify Search",
    icon: "Search",
    onActivate: () => {
      toggleSearchPopup();
    },
  });
});
