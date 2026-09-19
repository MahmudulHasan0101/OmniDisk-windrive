"""
OmniDisk on Google Colab — single-cell setup + launch script.

WHAT THIS DOES
  1. Mounts your Google Drive at /content/drive.
  2. Installs the OmniDisk source onto Drive (first run only) so both the
     code AND its database/credentials persist across Colab sessions —
     everything lives under My Drive/OmniDisk/, nothing is left on the
     Colab VM's throwaway local disk.
  3. Installs Node.js if this Colab runtime doesn't already have a recent
     enough version.
  4. Runs `npm install` + builds the web frontend (skipped on later runs
     if already done, so re-running this cell after a Colab disconnect is
     fast).
  5. Starts the OmniDisk server and asks Colab for a public URL pointing
     at it (Colab's built-in port-forwarding — no ngrok/localtunnel signup
     needed).
  6. Restarts the server once with that URL wired in, so the Google Drive
     OAuth flow (if you use it) redirects somewhere reachable instead of
     an unreachable "localhost".

USAGE
  1. New Colab notebook -> colab.research.google.com -> New notebook.
  2. First run only: drag the omnidisk.zip you were given into the file
     browser on the left sidebar, so it lands at /content/omnidisk.zip.
     (Any zip whose top-level folder is named "omnidisk", or that has
     exactly one top-level folder, works — the exact filename doesn't
     matter.) You will NOT need to do this again on future runs in the
     same Google account, since the code is copied onto Drive the first
     time and reused after that.
  3. Paste this entire file into one cell and run it (Shift+Enter).
  4. Click through the Google Drive mount permission prompt when it pops
     up — that's Colab asking to mount YOUR Drive, unrelated to OmniDisk's
     own Google Drive *provider* connection (a separate, later step,
     inside the OmniDisk web UI itself, with its own OAuth consent).
  5. Wait for the "OmniDisk is live at: ..." banner, then open that link.
  6. Leave the cell running — stopping it (or closing the browser tab
     running the notebook) stops the server. Re-running the cell later
     resumes from everything saved on Drive: same files, same connected
     provider accounts, same everything.

WHAT WORKS OUT OF THE BOX vs. WHAT NEEDS ONE EXTRA STEP
  MEGA and Supabase Storage need nothing beyond the normal in-app setup —
  no callback URL, no registration, connect and go.
  Google Drive (and any other OAuth provider once it gets an adapter) needs
  the redirect URI printed at the end of this script's output registered
  in Google Cloud Console, because Colab's public URL is different every
  session — see the printed instructions.
"""

import os
import shutil
import subprocess
import sys
import time
import zipfile

DRIVE_ROOT = "/content/drive/MyDrive/OmniDisk"
APP_DIR = f"{DRIVE_ROOT}/app"
DATA_DIR = f"{DRIVE_ROOT}/data"
PORT = 4310
READY_LINE_PREFIX = "OmniDisk listening on"


def run(cmd, cwd=None, env=None):
    print(f"$ {' '.join(cmd)}  (cwd={cwd or '.'})")
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def mount_drive():
    try:
        from google.colab import drive
    except ImportError:
        raise SystemExit(
            "This script is meant to run inside a Google Colab notebook "
            "(it needs google.colab, which isn't available here)."
        )
    print("Mounting Google Drive (approve the popup if prompted) ...")
    drive.mount("/content/drive")
    os.makedirs(DRIVE_ROOT, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)


def ensure_source():
    if os.path.exists(os.path.join(APP_DIR, "package.json")):
        print(f"Using existing OmniDisk source already on Drive at {APP_DIR}")
        return

    candidates = [
        os.path.join("/content", f)
        for f in os.listdir("/content")
        if f.lower().endswith(".zip")
    ]
    if not candidates:
        raise SystemExit(
            "No OmniDisk source found on Drive and no .zip file in /content.\n"
            "Drag the omnidisk.zip you were given into the Colab file browser "
            "(left sidebar) so it lands in /content, then re-run this cell."
        )
    zip_path = candidates[0]
    print(f"Extracting {zip_path} ...")
    extract_dir = "/content/_omnidisk_extract"
    shutil.rmtree(extract_dir, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)

    extracted_root = os.path.join(extract_dir, "omnidisk")
    if not os.path.isdir(extracted_root):
        entries = [e for e in os.listdir(extract_dir) if not e.startswith(".")]
        if len(entries) == 1 and os.path.isdir(os.path.join(extract_dir, entries[0])):
            extracted_root = os.path.join(extract_dir, entries[0])
        else:
            raise SystemExit(
                f"Couldn't find a single OmniDisk source folder inside {zip_path}. "
                "Make sure it's the project zip, not something else."
            )

    os.makedirs(DRIVE_ROOT, exist_ok=True)
    shutil.move(extracted_root, APP_DIR)
    shutil.rmtree(extract_dir, ignore_errors=True)
    print(f"Installed source onto Drive at {APP_DIR}")


def ensure_node():
    try:
        out = subprocess.run(["node", "-v"], capture_output=True, text=True, check=True)
        major = int(out.stdout.strip().lstrip("v").split(".")[0])
        if major >= 20:
            print(f"Node {out.stdout.strip()} already installed, skipping.")
            return
        print(f"Node {out.stdout.strip()} is too old (need >= 20) — upgrading.")
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("Node.js not found — installing.")

    run(["bash", "-c", "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"])
    run(["apt-get", "install", "-y", "nodejs"])


def npm_install_if_needed(dir_):
    if os.path.exists(os.path.join(dir_, "node_modules")):
        print(f"node_modules already present in {dir_}, skipping npm install.")
        return
    run(["npm", "install"], cwd=dir_)


def build_web_if_needed():
    web_dir = os.path.join(APP_DIR, "web")
    if os.path.exists(os.path.join(web_dir, "dist", "index.html")):
        print("web/dist already built, skipping.")
        return
    run(["npm", "run", "build"], cwd=web_dir)


def start_server(extra_env):
    env = os.environ.copy()
    env.update(extra_env)
    env["PORT"] = str(PORT)
    proc = subprocess.Popen(
        ["npx", "tsx", "index.ts"],
        cwd=os.path.join(APP_DIR, "server"),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise SystemExit("OmniDisk server exited before becoming ready — see output above.")
            continue
        print("[server]", line.rstrip())
        if READY_LINE_PREFIX in line:
            return proc
    proc.terminate()
    raise SystemExit("Timed out waiting for the OmniDisk server to start.")


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def get_public_url():
    from google.colab.output import eval_js

    return eval_js(f"google.colab.kernel.proxyPort({PORT})")


def stream_logs_forever(proc):
    try:
        for line in proc.stdout:
            print("[server]", line.rstrip())
    except KeyboardInterrupt:
        print("\nStopping OmniDisk ...")
        stop_server(proc)


def main():
    mount_drive()
    ensure_source()
    ensure_node()

    npm_install_if_needed(APP_DIR)
    npm_install_if_needed(os.path.join(APP_DIR, "server"))
    npm_install_if_needed(os.path.join(APP_DIR, "web"))
    build_web_if_needed()

    base_env = {"OMNIDISK_DATA_DIR": DATA_DIR}

    print("\nStarting OmniDisk (first pass, to obtain a public URL) ...")
    proc = start_server(base_env)
    public_url = get_public_url()
    print(f"Public URL obtained: {public_url}")

    print("\nRestarting once with that URL wired in (needed for Google Drive's OAuth redirect) ...")
    stop_server(proc)
    base_env["OMNIDISK_PUBLIC_URL"] = public_url
    proc = start_server(base_env)

    banner = "=" * 70
    print(f"\n{banner}\nOmniDisk is live at: {public_url}\n{banner}\n")
    print(
        "MEGA and Supabase Storage work immediately — no extra setup beyond "
        "the normal in-app account form.\n\n"
        "To use Google Drive as a storage provider, register this exact "
        "redirect URI in Google Cloud Console (Web application client "
        f"type):\n  {public_url}/api/providers/google_drive/oauth-callback\n\n"
        "This URL changes every time this cell is (re-)run, so that "
        "registration step needs redoing whenever you restart the Colab "
        "runtime — everything else (your files, connected accounts, "
        "settings) persists on Drive regardless.\n"
    )
    print("Leave this cell running. Stop it (■ button) to shut OmniDisk down.\n")

    stream_logs_forever(proc)


if __name__ == "__main__":
    main()
