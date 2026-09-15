import { createWebDavClient } from "./webdav";
import { createUpstashClient } from "./upstash";

export enum ProviderType {
  WebDAV = "webdav",
  UpStash = "upstash",
}

export const SyncClients = {
  [ProviderType.UpStash]: createUpstashClient,
  [ProviderType.WebDAV]: createWebDavClient,
} as const;

type SyncClientConfig = {
  [K in keyof typeof SyncClients]: (typeof SyncClients)[K] extends (
    _: infer C,
    ...args: any[]
  ) => any
    ? C
    : never;
};

export type SyncClient = {
  get: (key: string) => Promise<string>;
  set: (key: string, value: string) => Promise<void>;
  check: () => Promise<boolean>;
};

export type SyncClientOptions = {
  useProxy: boolean;
  proxyUrl: string;
  serverManaged: boolean;
  accessCode: string;
};

export function createSyncClient<T extends ProviderType>(
  provider: T,
  config: SyncClientConfig[T],
  options: SyncClientOptions,
): SyncClient {
  const createClient = SyncClients[provider] as (
    config: SyncClientConfig[T],
    options: SyncClientOptions,
  ) => SyncClient;
  return createClient(config, options);
}
