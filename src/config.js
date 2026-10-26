// Where the panel signs in and what it calls. CLIENT_ID is the public id of the Doorkeeper app
// "SnapDub Clips for Adobe Express" (registered through snapdub.ai/oauth/register with Adobe's two
// redirect pages). It is not a secret: the app is a public client and every sign-in proves itself
// with PKCE instead.
export const SNAPDUB_URL = "https://snapdub.ai";
export const CLIENT_ID = "9PQPwxxr7V83tnENGTqqQQIwkaVZ7tcKgcYKAAdvP-k";
export const SCOPE = "mcp";
