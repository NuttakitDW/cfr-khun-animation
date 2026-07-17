# kHold'em — Architecture & Integration Study

> Read-only investigation of the kHold'em installation on this host (`EC2AMAZ-OJ656GO`).
> No files, services, registry keys, or database rows were modified — only file reads and `SELECT`-only SQL queries were performed.
> Date: 2026-07-18 · Installed version: **3.17 (build 53)** · Setup type: **Server**

---

## 1. TL;DR

- **kHold'em** (by *eShark* / *LiPoker*) is a **.NET Framework 4.6** Windows poker-room / tournament-management suite. Install root: `C:\kHoldem`.
- It is a **client ↔ server** system. The **server** is a set of Windows services (all `kholdemhost.exe /service <name>`) that own **all business logic and the only sanctioned path to the data**. Clients (the `kholdem.exe` desktop app, tablets, media/clock screens, the web viewer) never touch the database directly — they talk to the server over a **WCF/binary TCP protocol**.
- The **system of record** is a local **SQL Server 2017** named instance **`.\KHOLDEM`**, database **`kHoldem`** (145 tables, 11 stored procs). The server connects to it with a **Windows trusted connection** (services run as `LocalSystem`).
- **Credentials to the DB are Windows-integrated (no password in any file).** Cloud/eShark credentials in `service.json` are **DPAPI-encrypted** and only decryptable by this machine's account.
- **Poker Bounty / PKO is already a native, shipped feature** — you do **not** need to build it. 144 of 403 tournaments in the live DB are already knockout/bounty events (standard bounty, Progressive KO, and Mystery Bounty are all modeled). See §7.
- **Best way to "write" into kHold'em:** drive the **server**, not the database. Three viable integration surfaces exist (Addon `.kpl` SDK, the client-protocol SDK assemblies, and the local Web/API service). Direct SQL writes are *technically* possible but **strongly discouraged** and effectively unsupported (see §6 and §8).

---

## 2. Physical layout (`C:\kHoldem`)

| Path | What it is |
|---|---|
| `kholdem.exe` | Desktop **client** (WinForms + DevExpress + WebView2). This is the operator UI. |
| `kholdemhost.exe` | **Service host** — one process per backend service (see §3). |
| `kholdemmedia.exe` | Media/clock renderer (tournament clock, displays). |
| `kHoldemQS.exe`, `eSharkSupport*.exe`, `diagnostictool.exe` | Quick-setup, remote-support (TeamViewer-style), diagnostics. |
| `Components\` | The application assemblies — `LiPoker.*.dll` (core), DevExpress UI, Twilio (SMS), AWS SNS, Chilkat, Google APIs, SignalR client, OWIN. |
| `Shared\` | Shared libraries. |
| `Addons\` | **Plug-in modules** (`*.kpl`): `triton`, `pslive`, `barriere`, `igt`, `pokerlens`, `eid`, `apt`, `cis`, `leris`, `luxon`, `neon`, `zino`, `direpay`, `ci`, `spider`. These are network/regulator/payment integrations — evidence of a **supported extension mechanism**. |
| `Web\` | The **local web + API** host content: legacy ASP.NET (`LiPokerWS`) pages (`Multimedia.aspx`, `TableManager.aspx`, `CashTouch.aspx`) **and** `Web\v2\` = a compiled **Angular** SPA (public live-results / clock viewer). |
| `Web\bin\LiPokerWS.dll` | The web-service assembly behind the API/pages. |
| `Configuration\syncengine.json` | Declarative map of every table that participates in **multi-site cloud sync** (see §5). |
| `Database\Release.bak` | Shipped baseline DB backup (used to provision the `kHoldem` DB on install). |
| `Runtimes\`, `Updates\`, language folders (`de/es/fr/it/zh/…`) | Runtime deps, updater payloads, localization. |

Runtime state (not under the install dir) lives in **`C:\ProgramData\kHoldem\`**:
`service.json` (connection + cloud identity), `version.json`, `*.lic` (license), `Log\`, `Data\`, `Database\`, `Addons\Server\` (installed server-side addon binaries: `Core`, `Sync`, `Backup`, `PokerLens`, `PrintEngine`, `Security`).

---

## 3. The services (how it's wired)

All backend services are the **same binary** launched with a different role: `C:\kHoldem\kholdemhost.exe /service <Name>`, all running as **`LocalSystem`**.

| Windows service | Role | Listening ports (this host) |
|---|---|---|
| **kHoldemServer** | **Core application server** — owns business logic, holds the SQL connection, serves all clients over WCF. This is the heart of the system. | **2505**, **5856**, **7215** (TCP) |
| **kHoldemWebServer** | **"Local Web Server + API"** — OWIN self-host + ASP.NET Web API (`LiPokerWS`), Swashbuckle/Swagger present. Serves the `Web\` pages + `v2` Angular app + REST endpoints. | **5855** (HTTP) |
| **kholdemsync** | **Cloud sync engine** — pushes/pulls the tables listed in `syncengine.json` to eShark cloud / other sites. | (outbound) |
| **kHoldemBackup** | Scheduled DB backups. | — |
| **kHoldemPrintEngine** | Ticket / receipt / report printing. | — |
| **kHoldemPokerLens** | "Poker Lens" RFID/card-recognition integration. | — |
| MSSQL$KHOLDEM | SQL Server (KHOLDEM) instance. | dynamic (via SQL Browser UDP 1434) |

**Wiring in one line:**

```
kholdem.exe (operator UI) ─┐
tablet / clock / display  ─┤── WCF/TCP (2505/5856/7215) ──► kHoldemServer ──► SQL Server .\KHOLDEM (db: kHoldem)
public web viewer (Angular)─┘                                   │  ▲
                                                                 │  └── kHoldemBackup / PrintEngine / PokerLens (siblings)
browser / integrations ──── HTTP (5855) ──► kHoldemWebServer ────┘ (also reads/writes via server/DB layer)
                                                                 
kholdemsync ── HTTPS ──► eShark Cloud (multi-venue sync, live results upload)
```

Server logs (`C:\ProgramData\kHoldem\Log\Server\*.log`) confirm the model: clients "log in from Device [name] as <user>", commands are dispatched to **handlers** (`AdministrationHandler`, `BaseConnection … Identified on 6 handlers`), and the stack is **`System.ServiceModel`** (WCF `ServiceChannel` / `FaultException`). When SQL briefly went away, the server — not the client — threw the connection error, proving the **server is the sole DB gateway**.

---

## 4. Where data is stored

- **Engine:** Microsoft **SQL Server 2017** (`MSSQL14.KHOLDEM`), instance **`.\KHOLDEM`**, running as `NT AUTHORITY\LOCALSERVICE`.
- **Database:** **`kHoldem`** — **145 tables**, 11 stored procedures.
- **Auth mode:** **Mixed** (`IsIntegratedSecurityOnly = 0`) — both Windows and SQL logins are enabled, but the app uses **Windows integrated (trusted)** auth. `service.json` contains a `Connection` block with **Server + Database but no username/password**, confirming trusted auth.
- **Keys:** almost every table uses a **`System.Guid` (uniqueidentifier)** primary key, generated app-side. There is a system column **`sync_lastupdated`** on synced tables used by the sync/optimistic-concurrency machinery.
- **Collation caveat:** columns mix `Latin1_General_CI_AS_KS_WS` and `SQL_Latin1_General_CP1_CI_AS` — string concatenation across the two throws a collation conflict (relevant if you write ad-hoc SQL).

Core domain areas (table families): **Tournament\*** (structure, levels, payouts, players, tables, rebuy/addon, reservations, waiting lists), **Cash\*** (cash-game sessions, rake, tips, hands), **Player / PlayerClub / PlayerVIP / VIP\***, **Ranking / Season / League**, **Transaction / Payment / Document (invoicing)**, **Mail / SMS** (marketing), **Server / Device / Domain** (topology & multi-site), **BlackList**, **Permission / Group / User** (RBAC).

---

## 5. Cloud sync & multi-site (`Configuration\syncengine.json`)

- Declares **~110 tables** that replicate, each with its GUID key(s) and which datetime columns are UTC vs date-only (`DateTimeMode`).
- `Account`, `Club`, `Player`, `Tournament` carry `NetworkLastUpload` / `NetworkLastDownload` / `LastUpdated` markers — this is a **timestamp-based, last-writer-wins style delta sync** to the eShark cloud (and between venues).
- **Implication for you:** if you write to the DB out-of-band, you must respect these markers or the sync engine will either **overwrite your change** or **push a corrupt delta** to the cloud. This is the single biggest reason not to bypass the server.

---

## 6. Credentials & secrets — what's needed to talk to each layer

| Target | Credential required | Where it lives |
|---|---|---|
| **SQL DB (`.\KHOLDEM` / `kHoldem`)** | A **Windows login** with rights on the instance (services use `LocalSystem`, which is `sysadmin` here). No SQL username/password stored anywhere. | Implicit (trusted). `Connection` block in `C:\ProgramData\kHoldem\service.json`. |
| **kHoldemServer (WCF)** | A **kHold'em user account** (username/password/permissions) — e.g. operator `zsop01` seen in logs — plus a registered **Device**. | `User` / `Device` / `Permission` tables in the DB; client stores its identity in `HKCU\SOFTWARE\kHoldem\Accounts\<email>`. |
| **eShark Cloud / sync / licensing** | Membership account (`zsop.team@gmail.com`), a **DPAPI-encrypted token**, cloud **AccessToken**, `licenseId`, `ServerID`. | `service.json` (`Membership.token`, `Cloud.AccessToken` — all `Encrypted:true` DPAPI blobs) + `*.lic` license file. |
| **Local Web/API (5855)** | App-level auth (the API returned HTTP 500 to anonymous probes — it expects proper routing/headers or a session). | `LiPokerWS` in `Web\bin`. |

**About the DPAPI blobs:** the `token` / `flags` / `AccessToken` values in `service.json` begin with `AQAAANCMnd8BFdER…` — the signature of **Windows DPAPI** ciphertext. They can only be decrypted **on this machine, by the account that encrypted them** (LocalSystem/user scope). They are **not** portable and **not** a reusable API key you can lift. Treat them as sensitive.

---

## 7. Poker Bounty / PKO — it already exists

**You do not need to implement bounty or PKO. kHold'em ships it as a first-class tournament type.** Evidence from the live `kHoldem` DB:

- **144 of 403 tournaments** already have `KnockOut = 1`.
- Real events present today include **"NLH Big Bounty: $3,000"**, **"Speed Racer – NLH Bounty"**, and **"NLH Mystery Bounty"**.

Relevant **`Tournament`** columns (the bounty configuration surface):

| Column | Type | Meaning |
|---|---|---|
| `KnockOut` | bit | Is this a bounty/KO tournament |
| `KnockOutType` | int | Variant — observed **`1` = standard bounty/KO**, **`3` = Mystery Bounty** (progressive uses the fields below) |
| `KnockOutAmount` | float | Bounty value per player (the KO prize) |
| `KnockOutProgressive` | float | **PKO** — portion of a claimed bounty that rolls onto the eliminator's own head |
| `KnockOutProgressiveRoundType` | int | Rounding rule for the progressive split |
| `KnockOutProgressiveRoundValue` | decimal | Rounding granularity |
| `KnockOutTax`, `KnockOutHouse` | bit | Whether tax / house-rake apply to the bounty portion |
| `TotalKnockOut` | decimal | Roll-up of bounty money in the prize pool |

Per-player bounty accounting lives in **`TournamentPlayers`**:
`KnockOutCount`, `KnockOutValue`, `KnockOutAmount`, `KnockedOutPlayerID`, `KnockedOutPlayersIDString` (who this player eliminated), and payout fields `PayoutKnockOutAmount`, `PayoutAmount`, `PayoutAssigned`.

**So "implement PKO" reduces to *configure* PKO**: create a tournament with `KnockOut = 1`, set `KnockOutType`, `KnockOutAmount`, and a non-zero `KnockOutProgressive` (+ rounding). This is exposed in the operator UI already; the schema and payout engine are in place. A custom project would only be needed for **non-standard bounty math** the built-in engine can't express — and even then you'd want to drive it through the server, not re-invent the tables.

---

## 8. Can we build our own service / side-car / write directly?

Three integration surfaces exist, in **descending order of safety/supportability**:

### Option A — Addon (`.kpl`) plugin  ✅ *Most native*
The `Addons\` folder shows kHold'em has a **first-party plug-in model** (`triton.kpl`, `pslive.kpl`, `direpay.kpl`, etc.), and server-side addon binaries are installed under `ProgramData\kHoldem\Addons\Server\`. There is a `LiPoker.Modules.Base.API.dll`. A `.kpl` runs **inside the server process**, so it gets the sanctioned data-access layer, sync-safe writes, and event hooks for free.
*Cost:* needs the eShark **Addon SDK / partner docs** (not present on this box) and likely signing.

### Option B — Client-protocol side-car ✅ *Recommended for external code*
Build a **standalone service that speaks the same WCF client protocol as `kholdem.exe`**, reusing the shipped SDK assemblies:
`LiPoker.Modules.Base.Client.dll`, `LiPoker.Modules.Base.API.dll`, `LiPoker.Network.dll`.
It authenticates as a **kHold'em user + registered Device**, connects to **kHoldemServer (2505/5856/7215)**, and issues the same commands the UI does (create tournament, register player, record elimination/bounty, assign payouts).
*Why this is the right "write" path:* every write goes through the server's validation, caching, permission checks, and **sync-marker bookkeeping** — so it stays consistent and cloud-sync-safe.
*Cost:* you must reverse/obtain the command contracts (the `LiPoker.Framework.Services.*` handler surface, e.g. `AdministrationHandler`) — feasible by reflecting the SDK DLLs, but unofficial.

### Option C — Local Web/API (port 5855)  ⚠️ *Limited / undocumented*
`kHoldemWebServer` self-hosts an ASP.NET Web API (`LiPokerWS`) with Swagger tooling compiled in. This is the cleanest transport (HTTP/JSON) **if** the endpoints you need are exposed. Observed today it is oriented at **live-results / display / cloud registration** (`/api/members`, `/api/countries`, the Angular viewer) and returns **500 to unauthenticated probes**, so the writable surface is unconfirmed. Worth enumerating its Swagger doc from an authenticated context before betting on it.

### Option D — Direct SQL writes  ❌ *Possible but do not*
Because SQL is **mixed-mode** and services run as `LocalSystem`, a process on this box *can* open a trusted connection and `INSERT/UPDATE` the `kHoldem` DB. **Don't**, except for read-only reporting:
- The server holds **in-memory caches**; out-of-band writes cause stale/incoherent state and won't appear until a reload.
- The **sync engine** keys off `sync_lastupdated` / `NetworkLast*`; hand-written rows get **overwritten** or pushed to the cloud as bad deltas.
- App-side **GUID keys, cross-table invariants, payout math, and permissions** are enforced in code, not (only) in constraints — you will create orphans/imbalances.
- It voids any support and can corrupt multi-venue replication.
- ✅ The **one safe direct-DB use is READ** (reporting/BI) — ideally against a **restored copy of `Database\Release.bak`** or a backup, not the live DB.

---

## 9. Recommended path for a "PKO / bounty" project

1. **First, confirm the built-in engine is insufficient.** Standard bounty, **Progressive KO**, and **Mystery Bounty** are already supported end-to-end (schema + payouts + live display). For most requirements, the deliverable is **configuration + a report/skin**, not code.
2. If you need **automation or external control** (e.g. auto-create nightly PKO events, feed eliminations from another system, custom bounty payout export):
   - **Read side:** query a **backup/restored copy** of the DB (`Tournament`, `TournamentPlayers`, `TournamentRebuyAddon`, payout tables) for dashboards/exports — safe and easy.
   - **Write side:** implement **Option B (client-protocol side-car)** using `LiPoker.Modules.Base.Client/API.dll`, or pursue **Option A (Addon SDK)** via eShark for a fully supported plug-in.
   - **Never** write tournament/player/payout rows straight into the live DB.
3. **Engage eShark for the Addon SDK + API docs.** Both the supported extension points (`.kpl`) and the Web API (`LiPokerWS`/Swagger) are theirs; official contracts turn Option A/B/C from reverse-engineering into a supported build.

---

## 10. Quick reference

- **Install:** `C:\kHoldem` · **State/secrets:** `C:\ProgramData\kHoldem` · **Logs:** `C:\ProgramData\kHoldem\Log`
- **DB:** `Server=.\KHOLDEM; Database=kHoldem; Integrated Security=SSPI` (trusted; no stored password)
- **Server (WCF):** TCP 2505 / 5856 / 7215 · **Local Web+API:** HTTP 5855 · **SQL Browser:** UDP 1434
- **Core assemblies:** `LiPoker.dll`, `LiPoker.Modules.Base.*`, `LiPoker.Network.dll`, `LiPokerWS.dll`
- **Extension points:** Addons `*.kpl` (server-side plug-ins) · client SDK DLLs · Web API (`LiPokerWS`)
- **Bounty/PKO:** native — `Tournament.KnockOut* / KnockOutProgressive*`, `TournamentPlayers.KnockOut* / PayoutKnockOutAmount`
- **Cloud:** eShark membership `zsop.team@gmail.com`, DPAPI-encrypted tokens in `service.json`, license in `*.lic`

*Investigation was strictly read-only: file reads + `SELECT` queries against the live DB. No kHold'em file, service, registry value, or database row was created, altered, or deleted.*