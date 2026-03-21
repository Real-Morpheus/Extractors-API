# Stream Bypass API

Auto-detect & extract direct stream links from HubCloud, GDFlix, VCloud, GoFile, GDirect, FilePress.

## Deploy to Render

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Set these settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click Deploy

Your API will be live at `https://<your-app>.onrender.com`

## Run Locally

```bash
npm install
npm start
# Server runs on http://localhost:3000
```

## Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Landing page with live tester |
| GET | `/health` | Health check |
| GET | `/bypass?url=<encoded>` | Auto-detect & extract |
| POST | `/bypass` | Same, body: `{"url":"..."}` |
| GET | `/extract/hubcloud?url=` | Force HubCloud extractor |
| GET | `/extract/vcloud?url=` | Force VCloud extractor |
| GET | `/extract/gdflix?url=` | Force GDFlix extractor |
| GET | `/extract/gdirect?url=` | Force GDirect extractor |
| GET | `/extract/filepress?url=` | Force FilePress extractor |
| GET | `/extract/gofile?url=` | Force GoFile extractor |

## Example

```bash
curl "https://your-app.onrender.com/bypass?url=https%3A%2F%2Fhubcloud.foo%2Fdrive%2Fabc123"
```
