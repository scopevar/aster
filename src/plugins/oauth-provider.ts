import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { AppError } from "../shared/core.js";
import type { OAuthCredentials } from "./oauth-credentials.js";

export function oauthProvider(
  data: OAuthCredentials,
  options: {
    check(): void;
    save(): Promise<void>;
    redirect(url: URL): void;
    state?: string;
  },
): OAuthClientProvider {
  let verifier: string | undefined, discovery: OAuthDiscoveryState | undefined;
  return {
    redirectUrl: data.redirectUrl,
    clientMetadata: {
      client_name: "aster",
      redirect_uris: [data.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state() {
      options.check();
      return options.state ?? "";
    },
    clientInformation() {
      options.check();
      if (!data.client) return;
      const { issuer, ...client } = data.client;
      return {
        ...client,
        redirect_uris: [data.redirectUrl],
        ...(issuer !== undefined ? { issuer } : {}),
      };
    },
    saveClientInformation(value) {
      options.check();
      data.client = value;
    },
    tokens() {
      options.check();
      if (!data.tokens) return;
      const { issuer, ...tokens } = data.tokens;
      return { ...tokens, ...(issuer !== undefined ? { issuer } : {}) };
    },
    async saveTokens(value) {
      options.check();
      data.tokens = {
        ...value,
        ...(value.refresh_token
          ? {}
          : data.tokens?.refresh_token
            ? { refresh_token: data.tokens.refresh_token }
            : {}),
      };
      await options.save();
    },
    redirectToAuthorization(url) {
      options.check();
      options.redirect(url);
    },
    saveCodeVerifier(value) {
      options.check();
      verifier = value;
    },
    codeVerifier() {
      options.check();
      if (!verifier)
        throw new AppError("unauthorized", "MCP 授权已失效，请重新连接账号。");
      return verifier;
    },
    saveDiscoveryState(value) {
      options.check();
      discovery = value;
    },
    discoveryState() {
      options.check();
      return discovery;
    },
    invalidateCredentials(scope) {
      options.check();
      if (scope === "all" || scope === "tokens") delete data.tokens;
      if (scope === "all" || scope === "client") delete data.client;
      if (scope === "all" || scope === "verifier") verifier = undefined;
      if (scope === "all" || scope === "discovery") discovery = undefined;
    },
  };
}
