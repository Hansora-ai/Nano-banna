
# Nano Banana Mini App (Netlify)

A minimal Telegram Mini App–friendly web app to upload 1–4 images, get public URLs via transfer.sh,
and call the KIE Nano Banana Edit API. All secrets stay server-side in Netlify Functions.

## Deploy (Netlify)

1. Create a new site on Netlify → **Deploy manually** → upload the ZIP from this folder.
2. In **Site settings → Environment variables**, add (optional if you keep defaults in the code):
   - `KIE_RUN_URL` = `https://kie.ai/nano-banana?model=google%2Fnano-banana-edit`
   - `KIE_API_KEY`  = `YOUR_KIE_API_KEY`
3. Deploy. Your site will be available at `https://<yoursite>.netlify.app`.
4. (Optional) Use this URL in **BotFather** for your WebApp Mini App button.

## Endpoints
- `/.netlify/functions/upload` — Accepts `{ files: [{name,type,data(base64)}] }`, returns `{ urls: [] }`.
- `/.netlify/functions/run-nano-banana` — Accepts `{ image_urls:[], output_format?, prompt? }`, proxies to KIE.

