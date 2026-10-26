# SnapDub Clips for Adobe Express

An Adobe Express add-on: sign in with your SnapDub account, pick one of your videos and put any of its
finished vertical clips on the page with a click or by dragging it.

## How it works

- `src/snapdub.js` signs in with OAuth 2.0 + PKCE through Adobe's popup (`addOnUISdk.app.oauth`) against
  `https://snapdub.ai/oauth/authorize`, swaps the code for tokens at `/oauth/token` from the panel (a public
  client, no secret), and calls the SnapDub MCP server at `/mcp` (`whoami`, `list_videos`, `list_clips`).
  snapdub.ai allows the add-on's origin on those three paths.
- `src/index.js` draws three screens (sign in, videos, clips). A clip is downloaded from its signed link and
  added with `addOnUISdk.app.document.addVideo`, or dragged with `enableDragToDocument`.
- `src/config.js` holds the SnapDub URL and the public OAuth client id.

## Develop

```
npm install
npm run start      # serves https://localhost:5241 (first run sets up a local SSL certificate)
```

In Adobe Express: Add-ons > Your add-ons > Add-on Development on, then connect `https://localhost:5241`.

## Package

```
npm run build && npm run package   # dist.zip for the Adobe developer console
```

`npm run package` refuses a manifest without `testId`, so it stays; the marketplace ignores `testId` and
`name` (the listing name is set in the console).
