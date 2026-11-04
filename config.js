/** Discord application (Developer Portal → your app → Application ID). */
export const CLIENT_ID = "1521597072434794527";

/**
 * Unpacked installs are always "development". Set true to preview the
 * release popup (no live debug / test presence / Discord setup) without packing.
 * Leave false before shipping.
 */
export const FORCE_RELEASE_UI = false;

/** Social Layer default presence scopes + PKCE (enable Public Client in OAuth2 settings). */
export const SCOPES = "openid sdk.social_layer_presence";

export const API_BASE = "https://discord.com/api/v10";

/**
 * HTTPS redirect for Firefox Android (no identity API).
 * Must also be listed in Discord Developer Portal → OAuth2 → Redirects.
 * Hosted from the public miruro-rpc-oauth GitHub Pages site.
 */
export const OAUTH_REDIRECT_URI =
  "https://d4rkov.github.io/miruro-rpc-oauth/callback.html";

export const ACTIVITY = {
  watchName: "Anime on Miruro! ッ",
  browseName: "Searching for Anime! ッ",
  browseDetails: "Looking for peak",
  buttonLabel: "Watch on Miruro! ッ",
  // Headless sessions need asset snowflake IDs or HTTPS URLs (not IPC name keys).
  // miruro: from GET /oauth2/applications/{id}/assets
  assetId: "1521633309145174119",
  assetUrl: `https://cdn.discordapp.com/app-assets/${CLIENT_ID}/1521633309145174119.png`,
  // small_image — Discord app art assets (play-mid2 / pause-mid).
  playUrl: `https://cdn.discordapp.com/app-assets/${CLIENT_ID}/1567356634215481375.png`,
  pauseUrl: `https://cdn.discordapp.com/app-assets/${CLIENT_ID}/1567355441883914363.png`
};
