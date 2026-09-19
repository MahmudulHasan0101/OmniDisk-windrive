# OmniDisk — Provider Setup & API Reference Guide

> **Companion documents:** `OmniDisk_MasterSpec.md` (architecture, data model, router) and `OmniDisk_Provider_Registry_UI_Spec.md` (the `ProviderDefinition` form schema for each provider below, used to drive the Providers tab). Each `##` section heading here corresponds 1:1 to a `setupGuideAnchor` in the registry doc, so the UI's "Setup guide →" link on each provider tile deep-links straight to that section.

This document goes provider-by-provider: how to register/set up developer access, what auth model it uses, the actual API calls OmniDisk's adapter will call (`getStorableSpace`, `store`, `retrieve`, `delete`), the Node SDK to use, free-tier limits, and the quirks that matter for a fragment-router (rate limits, minimum/maximum object size, upload chunking behavior).

Every provider adapter implements the same contract from the core skeleton:
```ts
getStorableSpace(): Promise<number>
store(fragment, data: Buffer): Promise<FileFragment>
retrieve(fragment): Promise<Buffer>
delete(fragment): Promise<void>
pingLatency(): Promise<number>
measureThroughput(): Promise<number>
```
Below, "maps to" tells you which underlying SDK/API calls each method wraps for that specific provider.

---

## 1. Google Drive

**Free tier:** 15 GB (shared across Drive/Gmail/Photos on that Google account).
**Auth model:** OAuth 2.0 (user-consent flow — not a static API key, since Drive is tied to a person's account).

### Setup steps
1. Go to **Google Cloud Console** → create a new project.
2. **APIs & Services → Library** → search "Google Drive API" → Enable.
3. **APIs & Services → OAuth consent screen** → choose **External** user type → fill in app name, support email → add the scope `https://www.googleapis.com/auth/drive.file` (this scope only grants access to files *your app created*, which is the correct least-privilege scope for OmniDisk — avoid the broader `drive` scope unless you need to browse the user's whole Drive).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type: **Web application** (see note below — don't use "Desktop app" despite that seeming like the natural fit for a local tool) → under **Authorized redirect URIs**, add exactly `http://127.0.0.1:4310/api/providers/google_drive/oauth-callback` → this gives you a `client_id` and `client_secret`.
   > **Why Web application, not Desktop app:** Google's Desktop-app client type has a "loopback exception" that's supposed to accept any `127.0.0.1`/`localhost` redirect without pre-registration — but in practice this is inconsistent once a path is involved (as opposed to a bare `http://localhost:PORT`), and picking it wrong is the most common cause of `Error 400: redirect_uri_mismatch`. Web application clients explicitly let you register the exact URI, and `http://127.0.0.1:...` is exempt from Google's usual HTTPS-only rule for redirect URIs precisely because it's a loopback address — so this works cleanly for a locally-run app like OmniDisk with no ambiguity. If you already created a Desktop app client and hit `redirect_uri_mismatch`, the fix is to create a new Web application client instead (the type can't be changed after creation) and add the redirect URI above.
5. Because the app is unverified during development, Google will cap it to **test users** (add your own Google account under "Test users" on the consent screen) or show an "unverified app" warning — fine for personal/local use; full verification is only needed if you plan to publish this publicly.
6. Run the OAuth flow once (OmniDisk opens a browser tab pointed at Google's consent screen; approving it redirects back to `http://127.0.0.1:4310/api/providers/google_drive/oauth-callback`, a route on OmniDisk's own local server — this must match the Authorized redirect URI you registered in step 4 exactly), capturing a `refresh_token` — store this in the credential vault; access tokens are short-lived (1 hour) and refreshed automatically from it.

### Node SDK
`googleapis` (official). Instantiate an `OAuth2Client`, set credentials, then `google.drive({ version: "v3", auth })`.

### API mapping
| Adapter method | Google Drive v3 call |
|---|---|
| `getStorableSpace()` | `drive.about.get({ fields: "storageQuota" })` → `limit - usage` |
| `store()` | `drive.files.create({ requestBody: { name, parents: [omnidiskFolderId] }, media: { body: stream } })` — use **resumable upload** for fragments over ~5MB |
| `retrieve()` | `drive.files.get({ fileId, alt: "media" }, { responseType: "stream" })` |
| `delete()` | `drive.files.delete({ fileId })` |

### Quirks
- Create one dedicated app folder (e.g. `OmniDisk_Fragments`) on first setup and store its `folderId`; never touch other folders.
- Resumable uploads are essential for large fragments — a single interrupted PUT shouldn't force a full re-upload.
- Drive enforces per-user rate limits (a default of ~1000 requests/100 sec/user); batch fragment uploads with the concurrency cap mentioned in the main spec (§8) to avoid 403 `userRateLimitExceeded`.
- `storageQuota.limit` can be absent for unlimited-quota Workspace accounts — treat missing `limit` as "effectively unbounded, but poll `usage` regardless."

---

## 2. OneDrive (Microsoft Graph)

**Free tier:** 5 GB.
**Auth model:** OAuth 2.0 via **Microsoft Identity Platform / Entra ID** (Azure AD app registration).

### Setup steps
1. Go to **portal.azure.com → Microsoft Entra ID → App registrations → New registration**.
2. Name it, set **Supported account types** to "Personal Microsoft accounts only" (unless you also want work/school accounts), and set a **Redirect URI** of type "Public client / native" (e.g. `http://localhost:PORT/callback` for the local OAuth loopback).
3. Under **API permissions**, add **Microsoft Graph → Delegated permissions**: `Files.ReadWrite`, `offline_access` (required to get a refresh token), `User.Read`.
4. Under **Certificates & secrets**: not required for a public/native client using PKCE — OmniDisk should use the **Authorization Code flow with PKCE**, no client secret needed (safer for a distributed desktop app).
5. Note the **Application (client) ID** and the **Directory (tenant) ID** (use `common` as the tenant if allowing both personal and org accounts).

### Node SDK
`@azure/msal-node` for the OAuth/token handling + `@microsoft/microsoft-graph-client` for the actual Graph API calls.

### API mapping
| Adapter method | Graph API call |
|---|---|
| `getStorableSpace()` | `GET /me/drive` → `quota.remaining` |
| `store()` (small, <4MB) | `PUT /me/drive/root:/OmniDisk/{path}:/content` |
| `store()` (large, ≥4MB) | Create an **upload session**: `POST /me/drive/root:/OmniDisk/{path}:/createUploadSession`, then `PUT` sequential byte-range chunks (max 60 MiB per chunk, must be a multiple of 320 KiB except the final chunk) |
| `retrieve()` | `GET /me/drive/root:/OmniDisk/{path}:/content` |
| `delete()` | `DELETE /me/drive/items/{item-id}` |

### Quirks
- The upload-session chunk-size constraint (multiples of 320 KiB) means OmniDisk's internal chunk size for OneDrive fragments should be chosen to divide cleanly, or the adapter needs to pad/handle the remainder correctly on the final chunk only.
- Throttling responses come back as HTTP 429 with a `Retry-After` header — respect it exactly rather than using a fixed backoff.
- Personal Microsoft accounts and work/school (Entra ID / SharePoint-backed) accounts have different quota reporting quirks; test against whichever your account type actually is.

---

## 3. Dropbox

**Free tier:** ~2 GB (basic account).
**Auth model:** OAuth 2.0.

### Setup steps
1. Go to **dropbox.com/developers/apps → Create app**.
2. Choose **Scoped access**, permission type **App folder** (recommended — isolates OmniDisk to `Apps/OmniDisk/` in the user's Dropbox rather than full access) or **Full Dropbox** if you want it to see everything (not recommended).
3. Under **Permissions** tab, enable scopes: `files.content.write`, `files.content.read`, `files.metadata.read`.
4. Under **Settings**, generate an OAuth2 flow: note the **App key** and **App secret**; set a redirect URI for the loopback callback.
5. Use the **Authorization Code flow with `token_access_type=offline`** to get a refresh token (Dropbox access tokens expire in ~4 hours; the refresh token doesn't expire unless revoked).

### Node SDK
`dropbox` (official JS SDK, isomorphic — works in Node).

### API mapping
| Adapter method | Dropbox API v2 call |
|---|---|
| `getStorableSpace()` | `usersGetSpaceUsage()` → `allocation.allocated - used` |
| `store()` (<150MB) | `filesUpload({ path, contents, mode: "add" })` |
| `store()` (≥150MB) | Upload-session flow: `filesUploadSessionStart` → `filesUploadSessionAppendV2` (repeat per chunk) → `filesUploadSessionFinish` |
| `retrieve()` | `filesDownload({ path })` |
| `delete()` | `filesDeleteV2({ path })` |

### Quirks
- Single `filesUpload` call is capped at 150MB — anything larger **must** use the session-based chunked upload, so OmniDisk's internal chunk size matters here for fragments approaching that size.
- Dropbox rate-limits aggressively on free tier; a `429` includes `Retry-After` — same handling pattern as OneDrive.
- Path components are case-insensitive but case-preserving — don't rely on case to disambiguate fragment file names.

---

## 4. Box

**Free tier:** ~10 GB (personal Box account).
**Auth model:** OAuth 2.0 (also supports JWT/Server-to-Server auth for enterprise apps, but for a personal free-tier account, standard OAuth2 user-consent is what applies).

### Setup steps
1. **developer.box.com → My Apps → Create New App → Custom App → User Authentication (OAuth 2.0)**.
2. Note the **Client ID** and **Client Secret** from the app's Configuration tab.
3. Add a **Redirect URI** for local loopback callback.
4. Under **Application Scopes**, enable "Read and write all files and folders stored in Box."
5. Run the standard authorization-code OAuth flow to get an access + refresh token pair (Box access tokens last 1 hour, refresh tokens are single-use and rotate — each refresh returns a **new** refresh token that must overwrite the stored one).

### Node SDK
`box-node-sdk` (official).

### API mapping
| Adapter method | Box API call |
|---|---|
| `getStorableSpace()` | `GET /2.0/users/me` → `space_amount - space_used` |
| `store()` (<50MB) | `POST /2.0/files/content` (simple upload) |
| `store()` (≥50MB, Box recommends chunking above ~20MB) | Chunked upload: `POST /2.0/files/upload_sessions` → `PUT` parts → `POST .../commit` |
| `retrieve()` | `GET /2.0/files/{file_id}/content` |
| `delete()` | `DELETE /2.0/files/{file_id}` |

### Quirks
- **Refresh token rotation is mandatory to handle correctly** — unlike Google/Dropbox where the refresh token is long-lived and reusable, Box invalidates the old refresh token every time you use it. The credential vault must overwrite atomically on every refresh or you'll get locked out.
- Free personal Box accounts have a **250MB single-file size cap** (irrespective of chunking) — this directly caps the max fragment size the router can plan for this account; the adapter's `getStorableSpace()` should also be conceptually capped by `min(freeSpace, 250MB)` per fragment, or the router needs a separate "max single object size" property per provider account.

---

## 5. pCloud

**Free tier:** ~10 GB (up to 20GB with referral/verification bonuses).
**Auth model:** OAuth 2.0.

### Setup steps
1. **docs.pcloud.com → My Apps → Create App** (pCloud has both EU and US data regions — note which one the account was created under, since API base URLs differ: `api.pcloud.com` for US, `eapi.pcloud.com` for EU).
2. Register the app, get `client_id`/`client_secret`, set a redirect URI.
3. Run OAuth authorization-code flow to get an access token (pCloud access tokens generally don't expire unless revoked, which simplifies the refresh logic compared to the above providers, but treat it as revocable and handle re-auth gracefully).

### Node SDK
No heavily-maintained official Node SDK — use direct REST calls via `axios`/`fetch` against the documented REST endpoints (this is a straightforward one to write a thin adapter for by hand).

### API mapping
| Adapter method | pCloud REST call |
|---|---|
| `getStorableSpace()` | `GET /userinfo` → `quota - usedquota` |
| `store()` | `PUT /uploadfile?folderid=X&filename=Y` (multipart body) |
| `retrieve()` | `GET /getfilelink` (returns a direct download URL) → fetch that URL |
| `delete()` | `POST /deletefile?fileid=X` |

### Quirks
- Must detect and use the correct regional endpoint (`api.pcloud.com` vs `eapi.pcloud.com`) — calling the wrong region's endpoint with a valid token from the other region fails.
- `getfilelink` returns a temporary direct-download URL rather than streaming file bytes directly from the API call itself — a two-step retrieval.

---

## 6. MEGA

**Free tier:** ~20 GB (sometimes with bonus achievements pushing it higher temporarily).
**Auth model:** Username/password-derived session (MEGA does not use standard OAuth2 — it uses its own cryptographic login scheme; all file content is also **end-to-end encrypted client-side** by MEGA's own design, which is actually a nice property to inherit for free).

### Setup steps
1. No developer console/app registration step in the traditional sense — MEGA doesn't require you to register an "app" the way Google/Microsoft/Dropbox/Box do.
2. You just need the account's email + password, used directly by the SDK to derive a session (the SDK handles MEGA's custom key-derivation and encryption handshake internally).
3. Because there's no OAuth consent screen, credential storage here is literally the account email/password (or, better, a stored session/API key produced after the SDK logs in) — this **must** go through the encrypted credential vault, never plaintext.

### Node SDK
`megajs` (community-maintained, widely used) — wraps MEGA's private API and handles the client-side encryption transparently.

### API mapping
`megajs` exposes a higher-level `Storage` object rather than raw REST verbs:
| Adapter method | megajs call |
|---|---|
| `getStorableSpace()` | `storage.spaceLeft` after `storage.ready` |
| `store()` | `storage.upload(fileName, buffer)` → returns a `File` node |
| `retrieve()` | `file.download()` (returns a readable stream) |
| `delete()` | `file.delete()` |

### Quirks
- Because MEGA encrypts client-side, `store`/`retrieve` are somewhat slower than a raw HTTP PUT/GET to the other providers — factor this into throughput probing so the priority manager doesn't unfairly rank it low due to encryption overhead vs. actual network speed.
- No official public REST documentation — you're relying on the community SDK's correctness; pin a specific version and test thoroughly, since MEGA has changed its internal protocol before, breaking older SDK versions.

---

## 7. GitHub (repo-based storage)

**Free tier:** effectively unlimited *repos*, but GitHub is emphatically **not designed as a blob store** — treat this provider as "usable but constrained," not a first-class target.
**Auth model:** Personal Access Token (fine-grained, scoped to specific repos) — simplest to set up of any provider here, no OAuth flow needed for a single-user local tool.

### Setup steps
1. **github.com/settings/tokens → Fine-grained tokens → Generate new token**.
2. Scope it to a single dedicated repository (create one just for this, e.g. `omnidisk-store`), with **Contents: Read and write** permission only.
3. Store the PAT directly in the credential vault (it's a static token, no refresh flow).

### Node SDK
`@octokit/rest` (official).

### API mapping
| Adapter method | GitHub API call |
|---|---|
| `getStorableSpace()` | No real quota API for this — GitHub doesn't expose a "free space" number. Treat this provider's capacity as a **configured soft cap** you set yourself (see quirks below), tracked locally rather than queried live. |
| `store()` | `PUT /repos/{owner}/{repo}/contents/{path}` (base64-encoded content in the request body — **inherently ~33% size overhead** from base64 encoding on top of the raw bytes) |
| `retrieve()` | `GET /repos/{owner}/{repo}/contents/{path}` (returns base64 content for files under 1MB via the Contents API; larger files need the **Git Data API** — `GET /repos/{owner}/{repo}/git/blobs/{sha}` — or a raw `media` Accept header) |
| `delete()` | `DELETE /repos/{owner}/{repo}/contents/{path}` (requires the blob's current `sha`) |

### Quirks — these are significant
- **Hard 100MB per-file limit** via the standard API route (warnings start at 50MB); anything larger must go through **Git LFS**, which isn't part of the plain Contents API and defeats the "no extra dependency" simplicity — recommend capping GitHub fragment size well under 100MB (e.g. 40–50MB) to leave headroom.
- No official "how much space do I have" endpoint — GitHub's free-tier soft limits are informal (~1GB recommended repo size, "warnings" past 5GB, hard blocks past a few GB in practice). OmniDisk should treat GitHub's `getStorableSpace()` as a **user-configured static ceiling**, not a live-probed value, and track actual usage locally against that ceiling.
- Base64 overhead means the *effective* usable capacity per fragment is smaller than the raw byte budget — the router's byte-accounting needs to account for encoded size, not raw size, when planning what fits.
- Every content write is a **git commit** under the hood, meaning the repo's history grows forever unless you periodically squash/rewrite it — plan for a maintenance job if this provider sees heavy churn (lots of file deletes/re-uploads).
- Rate limits are generous for authenticated requests (5,000/hour) but each fragment store/retrieve is one call, so factor this in for very fragmented files.

**Recommendation:** treat GitHub (and GitLab below) as a "bonus/overflow" provider near the bottom of default priority ranking, not a primary target, given these constraints.

---

## 8. GitLab (repo/package-based storage)

**Free tier:** similar informal repo-size guidance to GitHub, but GitLab also offers a **Generic Package Registry**, which is actually a *better* fit than raw git commits for blob storage, since it doesn't bloat git history the way GitHub's Contents API does.

**Auth model:** Personal Access Token.

### Setup steps
1. **gitlab.com → Edit Profile → Access Tokens → Add new token**, scope: `api` (or narrower `read_repository` + `write_repository` if only using the package registry route).
2. Create a dedicated project (e.g. `omnidisk-store`) to hold everything.

### Node SDK
`@gitbeaker/rest` (actively maintained GitLab API client) for project/repo metadata; for the package registry, plain `fetch`/`axios` PUT/GET calls are simplest since it's just a generic file-upload REST endpoint.

### API mapping (using the **Generic Package Registry** approach — recommended over raw Contents API)
| Adapter method | GitLab API call |
|---|---|
| `getStorableSpace()` | No live quota endpoint either — same as GitHub, use a configured static ceiling |
| `store()` | `PUT /projects/{id}/packages/generic/{package_name}/{version}/{file_name}` (raw binary body — **no base64 overhead**, unlike GitHub's Contents API) |
| `retrieve()` | `GET /projects/{id}/packages/generic/{package_name}/{version}/{file_name}` |
| `delete()` | `DELETE /projects/{id}/packages/{package_id}` (deletes the whole package version — plan fragment naming so one deletion doesn't collide with unrelated fragments) |

### Quirks
- The Generic Package Registry route is meaningfully better suited to this use case than GitHub's Contents API: no git-history bloat, no base64 overhead, and it's explicitly designed for arbitrary file storage.
- GitLab.com free tier has a **10GB/month transfer (egress) limit** on the SaaS instance, separate from storage — heavy download/retrieval activity can hit this before storage capacity becomes the constraint.
- Same "no live free-space query" limitation as GitHub — configured soft cap + locally-tracked usage.

---

## 9. Cloudflare R2 (S3-compatible)

**Free tier:** 10 GB storage, 10 million read (Class B) ops/month, 1 million write (Class A) ops/month — and notably **zero egress fees**, which matters a lot for a system that will do repeated downloads.
**Auth model:** API token → generates an Access Key ID / Secret Access Key pair, used exactly like AWS credentials with any S3 SDK.

### Setup steps
1. Cloudflare Dashboard → **R2** → create a bucket (e.g. `omnidisk-fragments`) — R2 must be "purchased" (enabled) on the account first, though the free tier itself costs nothing.
2. **R2 → Manage R2 API Tokens → Create API Token**. Choose **Object Read & Write**, scope it to just the `omnidisk-fragments` bucket, set a TTL or leave indefinite.
3. Copy the **Access Key ID** and **Secret Access Key** immediately (shown only once).
4. Note your **Account ID** (visible in the R2 dashboard/URL) — the S3-compatible endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Region is always `"auto"`.

### Node SDK
`@aws-sdk/client-s3` (same SDK reused for S3, R2, and B2's S3-compatible mode — see §14, this is the single biggest implementation-efficiency win in the whole provider list).

### API mapping
| Adapter method | S3 API call |
|---|---|
| `getStorableSpace()` | R2 has no native "quota remaining" S3 API — track the 10GB free-tier ceiling as a configured static cap, decremented by locally-tracked usage (mirrors the GitHub/GitLab situation, but for a different reason: R2 simply doesn't meter "remaining quota" the way Drive/OneDrive/Dropbox do) |
| `store()` | `PutObjectCommand` (small) or `Upload` from `@aws-sdk/lib-storage` (automatic multipart for large fragments) |
| `retrieve()` | `GetObjectCommand` → stream the `Body` |
| `delete()` | `DeleteObjectCommand` |

### Quirks
- Because there's no egress fee, R2 is an excellent candidate for a **high-priority download source** even if its write-side priority score is lower — consider whether the priority algorithm should weight retrieval-cost separately from storage-write-cost in a later phase.
- Multipart upload part size minimum is 5MB (standard S3 constraint) — relevant if your internal chunk size is smaller than that for a given fragment.

---

## 10. Backblaze B2

**Free tier:** 10 GB storage, plus free egress up to 3x your stored data per month (via the Bandwidth Alliance with Cloudflare, egress can be entirely free if served through Cloudflare).
**Auth model:** Application Key ID + Application Key. **Two separate API surfaces exist — pick one per adapter and stay consistent:**
- **B2 Native API**: custom to Backblaze, requires an explicit `b2_authorize_account` call to get a session auth token before any operation.
- **S3-Compatible API**: standard AWS SigV4 auth, usable with the exact same `@aws-sdk/client-s3` client as R2.

**Recommendation: use the S3-Compatible API** — it lets the B2 adapter share almost all code with the R2 and S3 adapters (see §14).

### Setup steps
1. Backblaze account → **App Keys → Add a New Application Key**.
2. **Important:** the auto-generated "master" application key does **not** work with the S3-Compatible API — you must manually create a new key here.
3. Scope it to a specific bucket, grant read+write capabilities (include both `writeFiles` and `deleteFiles` if you'll be deleting fragments), optionally enable `listAllBucketNames` if the key is bucket-scoped but you also want to list buckets.
4. Note the **keyID** (= Access Key ID) and **applicationKey** (= Secret Access Key) — shown only once.
5. Endpoint format: `https://s3.<region>.backblazeb2.com` (region shown on the bucket's details page, e.g. `us-west-004`).

### Node SDK
`@aws-sdk/client-s3` (same as R2/S3).

### API mapping
Identical shape to R2 above (`PutObjectCommand`/`Upload`, `GetObjectCommand`, `DeleteObjectCommand`) — `getStorableSpace()` again has no live-quota S3 call, so track the 10GB ceiling as a configured cap.

### Quirks
- If you ever need native-API-only features (lifecycle rules, native key management), that requires switching that specific adapter instance to the B2 Native API surface (`b2_authorize_account` → session token → `b2_upload_file`, etc.) — mixing both surfaces for the *same* bucket is fine, just pick one per adapter instance and don't build both.

---

## 11. Amazon S3

**Free tier:** 5GB (12-month Free Tier for new AWS accounts only — after 12 months, or on an older/existing account, there is no ongoing free storage; treat this provider account's "free space" as effectively zero/paid unless you've confirmed the account is within its Free Tier window).
**Auth model:** IAM user Access Key ID / Secret Access Key (or better: IAM role — but for a local desktop tool, a scoped IAM user is simplest).

### Setup steps
1. AWS Console → **IAM → Users → Create user** (do **not** use root account credentials).
2. Attach a custom policy scoped to a single bucket, granting only `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on that bucket's ARN — never attach `AdministratorAccess` or full `AmazonS3FullAccess` to a token that will live in a local app's credential vault.
3. Create an **Access Key** for that IAM user (Security credentials tab) — note the Access Key ID and Secret Access Key.
4. Create the S3 bucket itself (e.g. `omnidisk-fragments-yourname`, globally unique name) in your chosen region.

### Node SDK
`@aws-sdk/client-s3`.

### API mapping
Same shape as R2/B2 above. `getStorableSpace()`: S3 has no per-bucket quota concept at all (backed by effectively unlimited storage, billed per GB) — so for S3 specifically, "free space" isn't a real constraint the same way it is for the free-tier providers; the honest thing here is to treat S3 as **pay-as-you-go overflow capacity** rather than part of the "free space" pool, and let the user configure a spending-conscious soft cap if they want it included in routing at all.

### Quirks
- Given the above, S3 is somewhat philosophically different from the rest of the list — it's not "free storage," it's "storage you'll be billed for." Strongly consider making S3 (and Azure Blob / GCS below) **opt-in and off by default** in the priority list, clearly labeled as billed capacity, so a user doesn't accidentally route large amounts of data there and get a surprise invoice.

---

## 12. Azure Blob Storage

**Free tier:** trial credit only (no ongoing free storage tier akin to Drive/OneDrive's free quota) — same "billed overflow" caveat as S3.
**Auth model:** Storage Account connection string, or an Account Key, or (more securely) a scoped **SAS token**.

### Setup steps
1. Azure Portal → **Storage accounts → Create** → choose a resource group, unique storage account name, region.
2. Inside the account, create a **Container** (Azure's equivalent of an S3 bucket), e.g. `omnidisk-fragments`.
3. Under **Access keys**, copy a connection string, **or** (recommended for least privilege) generate a **Shared Access Signature (SAS)** scoped to just that container with only Read/Write/Delete permissions and an expiry date, which the app renews periodically rather than holding a permanent master key.

### Node SDK
`@azure/storage-blob` (official).

### API mapping
| Adapter method | Azure Blob SDK call |
|---|---|
| `getStorableSpace()` | No native quota API tied to billing-free space (same caveat as S3) — track a user-configured soft cap if included in routing at all |
| `store()` | `containerClient.getBlockBlobClient(path).uploadData(buffer)` (auto-handles chunking for large buffers via internal block-upload logic) |
| `retrieve()` | `blockBlobClient.download()` → returns a readable stream |
| `delete()` | `blockBlobClient.delete()` |

### Quirks
- Treat as billed overflow, same recommendation as S3 — opt-in only, clearly labeled.

---

## 13. Google Cloud Storage (GCS)

**Free tier:** a small **Always Free** tier (5GB regional storage in specific US regions, plus limited free operations/egress) distinct from the 15GB *Google Drive* consumer quota — don't conflate the two; GCS is a separate product/billing account even though it's the same company.
**Auth model:** Service Account JSON key.

### Setup steps
1. Google Cloud Console (can be the same project as Drive, or a separate one) → **IAM & Admin → Service Accounts → Create Service Account**.
2. Grant it the **Storage Object Admin** role, scoped to a specific bucket via a bucket-level IAM binding (avoid project-wide roles).
3. **Keys → Add Key → Create new key → JSON** — downloads a service-account credential file; store its contents in the credential vault (not as a loose file on disk).
4. Create a GCS bucket (e.g. `omnidisk-fragments`), and make sure it lands in a region eligible for the Always Free tier if you want to stay within it (currently `us-west1`, `us-central1`, `us-east1` — verify current eligible regions at setup time since this can change).

### Node SDK
`@google-cloud/storage` (official).

### API mapping
| Adapter method | GCS SDK call |
|---|---|
| `getStorableSpace()` | No live quota API for the free-tier ceiling — same static-cap pattern as other billed-cloud providers |
| `store()` | `bucket.file(path).save(buffer)` |
| `retrieve()` | `bucket.file(path).download()` |
| `delete()` | `bucket.file(path).delete()` |

### Quirks
- Same "verify current free-tier region eligibility" caveat as anything billing-related — this is one of the few facts in this whole document genuinely worth re-checking against Google's current published free-tier page before a user relies on it, since specifics (region list, exact GB/operations counts) do get revised.

---

## 14. WebDAV (generic provider)

**Free tier:** entirely dependent on whichever WebDAV-speaking service the user points this at (Nextcloud instance, Yandex Disk, Koofr, a self-hosted server, etc.) — this adapter's job is to be a generic fallback that works against *any* compliant WebDAV endpoint.
**Auth model:** Basic Auth (username/password) or Bearer token, depending on the specific WebDAV server.

### Setup steps
1. User supplies: base URL of the WebDAV endpoint, username, password (or token).
2. No provider-specific developer console — configuration happens entirely inside OmniDisk's "Add provider account" form (base URL + credentials fields).

### Node SDK
`webdav` (community-maintained, solid, handles PROPFIND/PUT/GET/DELETE cleanly).

### API mapping
| Adapter method | WebDAV call |
|---|---|
| `getStorableSpace()` | `PROPFIND` with the `quota-available-bytes` / `quota-used-bytes` DAV properties — **not all servers implement this**; if absent, fall back to a user-configured static cap |
| `store()` | `PUT {path}` |
| `retrieve()` | `GET {path}` |
| `delete()` | `DELETE {path}` |

### Quirks
- This is the least standardized entry in the whole list — quota reporting, chunked/resumable upload support, and even basic auth vs. digest auth vary by server implementation. Build this adapter defensively: assume the quota property is missing until proven otherwise, and don't assume large-file resumable upload support exists (plain single PUT per fragment is the safe baseline).

---

## 15. Supabase Storage

**Status:** implemented — `server/providers/supabase-account.ts` (`SupabaseAccount`).
**Free tier:** 1 GB file storage, capped at 50 MB per file, shared with your project's 500MB database allowance under one project-wide quota. Free projects auto-pause after 7 days with zero API requests (data isn't lost, just offline until manually resumed from the dashboard — OmniDisk's own periodic priority-refresh probing incidentally counts as activity, so an account actively in rotation won't hit this).
**Auth model:** API key (`service_role` secret key) — no OAuth flow.

### Setup steps
1. Create a project at [supabase.com](https://supabase.com) (free, no card required).
2. **Project Settings → Data API** → copy the **Project URL** (`https://xxxxxxxxxxxx.supabase.co`).
3. **Project Settings → API Keys** → copy the **`service_role`** secret key — **not** the `anon`/publishable key. The anon key respects Row Level Security and can't create buckets or write arbitrary objects; `service_role` bypasses RLS entirely, which is what OmniDisk needs to manage its own dedicated bucket. Because of that, treat this key like a root password — it grants full read/write over the whole project, not just Storage.
4. That's it — no bucket needs to be created manually. `SupabaseAccount` creates a private bucket named `omnidisk-fragments` on first use if one doesn't already exist.

### Node SDK
`@supabase/supabase-js` — `createClient(projectUrl, serviceRoleKey)`, then everything goes through `client.storage`.

### API mapping
| Adapter method | Supabase Storage call |
|---|---|
| `getStorableSpace()` | No live quota endpoint exists for this (the 1GB limit is enforced project-wide, not exposed per-bucket) — lists every object in `omnidisk-fragments` via `storage.from(bucket).list()` (paginated), sums `metadata.size`, and subtracts from the user-configured `freeSpaceCapGB` |
| `store()` | `storage.from(bucket).upload(path, buffer, { upsert: true })` — `upsert: true` makes retries idempotent (overwrite instead of erroring on a name collision) |
| `retrieve()` | `storage.from(bucket).download(path)` → returns a `Blob`; convert via `Buffer.from(await blob.arrayBuffer())` |
| `delete()` | `storage.from(bucket).remove([path])` |

### Quirks
- **Hard 50MB-per-file cap, not a soft/advisory one** — uploads over that are rejected outright by Supabase. `maxSingleObjectBytes: 50_000_000` is set on this provider's registry entry specifically so `planAllocation` (see `fragment-router.ts`) splits this account's share of a file into multiple ≤50MB fragments instead of one oversized one.
- The 1GB limit is **project-wide**, not bucket-specific — if you use the same Supabase project for anything else, that usage eats into the same budget. `getStorableSpace()` only knows about what's in `omnidisk-fragments`, so the configured cap should leave headroom if you're sharing the project.
- `service_role` key has zero scoping — there's no way to mint a key restricted to just Storage, just this one bucket, or read-only. Treat it as fully privileged.

---

## 16. Cross-Provider Implementation Notes

### The S3-compatible trio (R2, B2, S3) should share one adapter class
`R2Account`, `B2Account`, and `S3Account` can all be thin subclasses (or just differently-configured instances) of a single `S3CompatibleAccount extends ProviderAccountBase`, parameterized by `endpoint`, `region`, `accessKeyId`, `secretAccessKey`, and a `freeSpaceCapBytes` override (since only R2/B2 have a genuine free tier; S3 doesn't). This is the single biggest code-reuse opportunity in the whole provider list — build this one first, and R2/B2/S3 support arrives almost for free together.

### Providers with no live "free space" API
Google Drive, OneDrive, Dropbox, Box, pCloud, MEGA all expose a real, queryable quota. **GitHub, GitLab, R2, B2, S3, Azure, GCS, and generic WebDAV servers (usually) do not.** For this second group, `getStorableSpace()` should return `configuredCapBytes - locallyTrackedUsedBytes` rather than attempting a live network probe — this needs to be a first-class supported mode in `ProviderAccountBase`, not a workaround bolted onto individual adapters. Add an `isLiveQuota: boolean` flag to `ProviderAccountStats` so the UI can show "estimated" vs. "confirmed" free space accordingly.

### App-level vs. account-level credentials (maps to the DB schema)
For the four OAuth2 providers in this guide (Google Drive, OneDrive, Dropbox, Box), the client_id/client_secret obtained in "Setup steps" step 1–4 of each section above is entered into OmniDisk **once** and lives in the `provider_app_configs` table (master spec §5.2) — it is not part of any single account's row. Every subsequent "add another account" for that same provider type reuses that row and only runs a fresh OAuth browser consent, landing in a new `provider_accounts` row with the next `account_index`. The remaining ten providers (MEGA, GitHub, GitLab, R2, B2, S3, Azure, GCS, WebDAV, pCloud) have no such split — every field in their "Setup steps" belongs to one specific `provider_accounts` row, since there's no shared "app" concept to factor out. See the registry companion doc §1 for the full rationale and §2 for the exact field-by-field schema this maps to.

### OAuth refresh-token handling differs meaningfully per provider
- Google, Dropbox, MEGA(session): long-lived refresh token, reusable indefinitely until revoked.
- Microsoft/OneDrive, Box: refresh tokens **rotate on every use** — the vault write must be atomic (write-new-then-delete-old, never the reverse) or a crash mid-refresh can strand the account requiring full re-auth.
- GitHub, GitLab: static Personal Access Tokens, no refresh flow at all — simplest case, but the user must remember to regenerate/rotate them manually before expiry if they set one.

### Suggested default priority order for a first-time setup
Given free-tier size, live-quota support, and lack of odd constraints (like GitHub's 100MB cap or Box's 250MB cap), a reasonable **out-of-the-box manual ranking** before the speed/latency probes have any data to go on:
1. Google Drive (15GB, live quota, mature SDK)
2. MEGA (~20GB, live quota, though slower due to client-side encryption)
3. pCloud (~10GB, live quota)
4. Box (~10GB, live quota, but 250MB/file cap)
5. Cloudflare R2 (10GB, free egress, no live quota — configured cap)
6. Backblaze B2 (10GB, no live quota — configured cap)
7. OneDrive (5GB, live quota, chunk-size constraints)
8. Dropbox (~2GB, live quota, 150MB simple-upload cap)
9. GitLab generic packages (soft cap, no base64 overhead)
10. GitHub Contents API (soft cap, base64 overhead, 100MB file cap) — last resort
11. WebDAV (depends entirely on the specific server)
12. S3 / Azure / GCS — **off by default**, opt-in only, clearly marked as billed rather than free

This is exactly the kind of ordering the Speed/Latency auto-probe (§7 of the master spec) will revise once real throughput numbers come in — the list above is just a sane cold-start default before any data exists.
