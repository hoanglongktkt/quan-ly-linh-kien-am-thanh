<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/4b0305db-ca33-45dc-8859-bc60ae5c104d

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## cPanel deployment

Build only on the local development machine:

```powershell
npm run build
git add server.cjs
git commit -m "build: update precompiled cPanel server"
git push
```

cPanel/Passenger must use `server.cjs` as its startup file and run `npm start` only. Do not run `npm run build`, `tsx`, Vite, or any compile command on cPanel. `npm run build:cpanel` only verifies that the prebuilt `server.cjs` exists.
