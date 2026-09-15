import { ACCESS_CODE_PREFIX, STORAGE_KEY } from "@/app/constant";
import { SyncStore } from "@/app/store/sync";
import { chunks } from "../format";
import { SyncClientOptions } from ".";

export type UpstashConfig = SyncStore["upstash"];
export type UpStashClient = ReturnType<typeof createUpstashClient>;

export function createUpstashClient(
  store: SyncStore,
  options: SyncClientOptions,
) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;
  const chunkCountKey = `${storeKey}-chunk-count`;
  const chunkIndexKey = (i: number) => `${storeKey}-chunk-${i}`;

  const proxyUrl =
    options.useProxy && options.proxyUrl.length > 0
      ? options.proxyUrl
      : undefined;

  return {
    async check() {
      try {
        const res = await fetch(this.path(`get/${storeKey}`, proxyUrl), {
          method: "GET",
          headers: this.headers(),
        });
        console.log("[Upstash] check", res.status, res.statusText);
        return [200].includes(res.status);
      } catch (e) {
        console.error("[Upstash] failed to check", e);
      }
      return false;
    },

    async redisGet(key: string) {
      const res = await fetch(this.path(`get/${key}`, proxyUrl), {
        method: "GET",
        headers: this.headers(),
      });

      console.log("[Upstash] get key = ", key, res.status, res.statusText);
      const resJson = (await res.json()) as { result: string };

      return resJson.result;
    },

    async redisSet(key: string, value: string) {
      const res = await fetch(this.path(`set/${key}`, proxyUrl), {
        method: "POST",
        headers: this.headers(),
        body: value,
      });

      console.log("[Upstash] set key = ", key, res.status, res.statusText);
    },

    async get() {
      const chunkCount = Number(await this.redisGet(chunkCountKey));
      if (!Number.isInteger(chunkCount)) return;

      const chunks = await Promise.all(
        new Array(chunkCount)
          .fill(0)
          .map((_, i) => this.redisGet(chunkIndexKey(i))),
      );
      console.log("[Upstash] get full chunks", chunks);
      return chunks.join("");
    },

    async set(_: string, value: string) {
      // upstash limit the max request size which is 1Mb for “Free” and “Pay as you go”
      // so we need to split the data to chunks
      let index = 0;
      for await (const chunk of chunks(value)) {
        await this.redisSet(chunkIndexKey(index), chunk);
        index += 1;
      }
      await this.redisSet(chunkCountKey, index.toString());
    },

    headers() {
      // when the sync is managed by the server, the server holds the upstash
      // token. we only send the access code so the proxy can authorize us.
      if (options.serverManaged) {
        return {
          Authorization: `Bearer ${ACCESS_CODE_PREFIX}${options.accessCode}`,
        };
      }

      return {
        Authorization: `Bearer ${config.apiKey}`,
      };
    },
    path(path: string, proxyUrl: string = "") {
      if (!path.endsWith("/")) {
        path += "/";
      }
      if (path.startsWith("/")) {
        path = path.slice(1);
      }

      if (proxyUrl.length > 0 && !proxyUrl.endsWith("/")) {
        proxyUrl += "/";
      }

      let url;
      const pathPrefix = "/api/upstash/";

      try {
        let u = new URL(proxyUrl + pathPrefix + path);
        // add query params
        if (!options.serverManaged) {
          u.searchParams.append("endpoint", config.endpoint);
        }
        url = u.toString();
      } catch (e) {
        url = pathPrefix + path;
        if (!options.serverManaged) {
          url += "?endpoint=" + config.endpoint;
        }
      }

      return url;
    },
  };
}
