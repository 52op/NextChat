import { getClientConfig } from "../config/client";
import { ApiPath, STORAGE_KEY, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import {
  AppState,
  getLocalAppState,
  GetStoreState,
  mergeAppState,
  setLocalAppState,
} from "../utils/sync";
import { downloadAs, readFromFile } from "../utils";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";
import { createSyncClient, ProviderType } from "../utils/cloud";
import { useAccessStore } from "./access";
import { isAppStateHydrated } from "../utils/sync";

export interface WebDavConfig {
  server: string;
  username: string;
  password: string;
}

const isApp = !!getClientConfig()?.isApp;
export type SyncStore = GetStoreState<typeof useSyncStore>;

// auto sync runs at most once per page session
let autoSyncStarted = false;
let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Wait for the server managed sync config and the access code to be available,
 * then run the auto sync. Checks on every access store change (e.g. the user
 * just typed the access code) and falls back to a short polling loop so the
 * config fetched from /api/config can become available.
 */
export function registerAutoSync() {
  if (typeof window === "undefined" || autoSyncTimer) return;

  const attempt = () => {
    useSyncStore
      .getState()
      .autoSync()
      .then((done) => {
        // once settled (done or not applicable), stop polling. the subscribe
        // listener stays active so entering the access code later still works.
        if (done) {
          clearAutoSyncTimer();
        }
      });
  };

  // the access store may publish the serverSyncProvider / accessCode later
  useAccessStore.subscribe(attempt);

  autoSyncTimer = setInterval(attempt, 1000);
  // give up after 30s, not blocking the app longer than necessary
  setTimeout(clearAutoSyncTimer, 30 * 1000);
}

function clearAutoSyncTimer() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
}

const DEFAULT_SYNC_STATE = {
  provider: ProviderType.WebDAV,
  useProxy: true,
  proxyUrl: ApiPath.Cors as string,

  webdav: {
    endpoint: "",
    username: "",
    password: "",
  },

  upstash: {
    endpoint: "",
    username: STORAGE_KEY,
    apiKey: "",
  },

  lastSyncTime: 0,
  lastProvider: "",
};

export const useSyncStore = createPersistStore(
  DEFAULT_SYNC_STATE,
  (set, get) => ({
    serverSyncProvider() {
      return useAccessStore.getState().serverSyncProvider;
    },

    effectiveProvider() {
      return (this.serverSyncProvider() || get().provider) as ProviderType;
    },

    cloudSync() {
      if (this.serverSyncProvider()) return true;
      const config = get()[get().provider];
      return Object.values(config).every((c) => c.toString().length > 0);
    },

    markSyncTime() {
      set({
        lastSyncTime: Date.now(),
        lastProvider: this.effectiveProvider(),
      });
    },

    export() {
      const state = getLocalAppState();
      const datePart = isApp
        ? `${new Date().toLocaleDateString().replace(/\//g, "_")} ${new Date()
            .toLocaleTimeString()
            .replace(/:/g, "_")}`
        : new Date().toLocaleString();

      const fileName = `Backup-${datePart}.json`;
      downloadAs(JSON.stringify(state), fileName);
    },

    async import() {
      const rawContent = await readFromFile();

      try {
        const remoteState = JSON.parse(rawContent) as AppState;
        const localState = getLocalAppState();
        mergeAppState(localState, remoteState);
        setLocalAppState(localState);
        location.reload();
      } catch (e) {
        console.error("[Import]", e);
        showToast(Locale.Settings.Sync.ImportFailed);
      }
    },

    getClient() {
      const provider = this.effectiveProvider();
      const client = createSyncClient(provider, get(), {
        useProxy: get().useProxy,
        proxyUrl: get().proxyUrl,
        serverManaged: !!this.serverSyncProvider(),
        accessCode: useAccessStore.getState().accessCode,
      });
      return client;
    },

    async sync() {
      const localState = getLocalAppState();
      const provider = this.effectiveProvider();
      const config = get()[provider];
      const client = this.getClient();

      try {
        const remoteState = await client.get(config.username);
        if (!remoteState || remoteState === "") {
          await client.set(config.username, JSON.stringify(localState));
          console.log(
            "[Sync] Remote state is empty, using local state instead.",
          );
          return;
        } else {
          const parsedRemoteState = JSON.parse(
            await client.get(config.username),
          ) as AppState;
          mergeAppState(localState, parsedRemoteState);
          setLocalAppState(localState);
        }
      } catch (e) {
        console.log("[Sync] failed to get remote state", e);
        throw e;
      }

      await client.set(config.username, JSON.stringify(localState));

      this.markSyncTime();
    },

    async check() {
      const client = this.getClient();
      return await client.check();
    },

    /**
     * Automatically pull-merge-push the cloud state once, right after the
     * server managed sync config is known and the user is authorized.
     * Only runs for server managed sync (SYNC_PROVIDER env var), so that a
     * new device just needs the access code to get all chat history.
     *
     * Returns true when the auto sync has settled (either performed, or not
     * applicable), false when it should be retried later.
     */
    async autoSync() {
      if (autoSyncStarted) return true;

      // in the desktop app there is no server, nothing to auto sync
      if (getClientConfig()?.buildMode === "export") {
        autoSyncStarted = true;
        return true;
      }

      const accessState = useAccessStore.getState();

      // wait until the server config (/api/config) has been fetched at least
      // once, otherwise we cannot tell if the sync is server managed or not
      if (!accessState.configLoaded()) return false;

      // not server managed: keep the manual sync behavior
      if (!accessState.serverSyncProvider) {
        autoSyncStarted = true;
        return true;
      }

      // if the deployment requires a code, the server managed provider needs
      // that access code to pass the proxy auth
      if (accessState.needCode && !accessState.accessCode) return false;

      // wait for all local stores to be hydrated before touching the cloud,
      // otherwise an empty local state could be uploaded on first visit
      if (!isAppStateHydrated()) return false;

      autoSyncStarted = true;
      console.log("[AutoSync] start");
      try {
        await this.sync();
        console.log("[AutoSync] success");
      } catch (e) {
        console.error("[AutoSync] failed", e);
      }
      return true;
    },
  }),
  {
    name: StoreKey.Sync,
    version: 1.2,

    migrate(persistedState, version) {
      const newState = persistedState as typeof DEFAULT_SYNC_STATE;

      if (version < 1.1) {
        newState.upstash.username = STORAGE_KEY;
      }

      if (version < 1.2) {
        if (
          (persistedState as typeof DEFAULT_SYNC_STATE).proxyUrl ===
          "/api/cors/"
        ) {
          newState.proxyUrl = "";
        }
      }

      return newState as any;
    },
  },
);
