# Running OmniDisk on Google Colab

Runs the whole app — server, frontend, database, credential vault, and any
files you upload through it — inside a Colab notebook, with everything
that needs to survive a session restart stored on your Google Drive.

## Quick start

1. Open [colab.research.google.com](https://colab.research.google.com) → New notebook.
2. Drag the `omnidisk.zip` you were given into the file browser on the left
   sidebar (drops it into `/content`). One-time step — later runs reuse the
   copy this script saves to Drive.
3. Paste the contents of [`run_omnidisk_colab.py`](./run_omnidisk_colab.py)
   into a cell and run it.
4. Approve the Drive-mount permission prompt.
5. Wait for the `OmniDisk is live at: ...` banner and open that link.

Re-running the cell later (new Colab session, same Google account) skips
straight to starting the server — your code, database, and connected
provider accounts are all still on Drive from last time.

## What lives where

| | Location |
|---|---|
| App source | `My Drive/OmniDisk/app/` |
| Database, credential vault, cache | `My Drive/OmniDisk/data/` |
| Files you upload through OmniDisk | Wherever you told OmniDisk to store them (MEGA, Google Drive, Supabase, ...) — Colab and Drive are never a storage *provider* here, just where the app itself lives |

## Provider setup on Colab specifically

- **MEGA, Supabase Storage:** no difference from running locally — just
  fill in the account form inside the app.
- **Google Drive (or any future OAuth provider):** Colab's public URL is
  different every session, so the redirect URI Google needs registered
  changes each time too. The script prints the exact URL to register after
  it starts — see its output. This is a genuine limitation of running an
  OAuth callback behind an ephemeral tunnel, not something worth working
  around with a paid static-domain tunnel service for personal use.

## Uploading and downloading files

Once the link is open, upload/download work exactly like running it
locally — your browser talks to the Colab-hosted server over that public
link. A download is reconstructed from your connected providers into the
server's temp directory and streamed to your browser in the same request,
same as it would be running on your own machine; nothing extra to do.

## Why one script instead of a notebook with several cells

Everything is idempotent (checks before installing/building/copying), so
the same single cell works whether it's the very first run or the fifth —
no "run cells 1 through 4 in order, skip cell 3 if..." instructions to get
wrong.
