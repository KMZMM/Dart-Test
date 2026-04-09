import axios, { AxiosInstance } from "axios";
import https from "node:https";

export type OutlineAccessKey = {
  id: string;
  name?: string;
  accessUrl: string;
};

type OutlineListKeysResponse = {
  accessKeys: OutlineAccessKey[];
};

type OutlineCreateKeyResponse = OutlineAccessKey;
type OutlineSetLimitRequest = {
  limit: {
    bytes: number;
  };
};

function sanitizeOutlineBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export class OutlineManagerClient {
  private readonly client: AxiosInstance;

  constructor(baseUrl: string, allowInsecureTls = true) {
    const normalizedBaseUrl = sanitizeOutlineBaseUrl(baseUrl);
    this.client = axios.create({
      baseURL: normalizedBaseUrl,
      timeout: 15000,
      httpsAgent: new https.Agent({ rejectUnauthorized: !allowInsecureTls }),
    });
  }

  async listAccessKeys(): Promise<OutlineAccessKey[]> {
    const response = await this.client.get<OutlineListKeysResponse>("/access-keys");
    return response.data.accessKeys ?? [];
  }

  async createAccessKey(name?: string, dataLimitBytes?: number): Promise<OutlineAccessKey> {
    const response = await this.client.post<OutlineCreateKeyResponse>("/access-keys");
    const key = response.data;
    if (dataLimitBytes && key.id) {
      try {
        await this.setDataLimit(key.id, dataLimitBytes);
      } catch {
        // Ignore limit errors and still return key.
      }
    }
    if (name && key.id) {
      try {
        await this.renameAccessKey(key.id, name);
        return { ...key, name };
      } catch {
        return key;
      }
    }
    return key;
  }

  async renameAccessKey(keyId: string, name: string): Promise<void> {
    await this.client.put(`/access-keys/${encodeURIComponent(keyId)}/name`, { name });
  }

  async setDataLimit(keyId: string, bytes: number): Promise<void> {
    const payload: OutlineSetLimitRequest = {
      limit: { bytes },
    };
    await this.client.put(`/access-keys/${encodeURIComponent(keyId)}/data-limit`, payload);
  }
}
