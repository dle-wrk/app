# Scanner app ↔ Tracklab IM: the API contract

For whoever works on the scanner phone app (`ghostsji/scannerapp2`). This is what Tracklab IM
implements; it replaces the suggested contract in the original handoff brief where they differ.
Server code: `src/lib/scansRoutes.ts`, `src/lib/scanStorage.ts`, sign-in in `src/lib/authRoutes.ts`.

Base URL: `https://tracklab-im.fly.dev` (put it in Expo config as `EXPO_PUBLIC_API_URL`).
All bodies are JSON unless stated. Errors are always `{ "error": "a sentence you can show the user" }`.

## What changed from the brief

| Brief | Tracklab |
|---|---|
| `email\|username` | Email only. Tracklab accounts have no username. |
| `image_url` column, files on disk / S3 | Photos are stored by Tracklab and served from `GET /api/scans/:id/image`, which **needs the token** like every other call. |
| no retry rule | Send a `clientRef` per scan; resending it returns the saved scan instead of a duplicate. |
| — | Optional `thumbnail` file and `capturedAt` field on a scan. |
| — | `GET /api/scans/lookup` to check a pick note number while the user types. |
| — | `GET /api/mobile/me` to check a stored token on start-up. |

## Signing in

```
POST /api/mobile/login      { "email": "...", "password": "..." }
200  { "token": "<48 hex chars>", "expiresAfterIdleDays": 30,
       "user": { "id": 7, "name": "Sam Nkosi", "email": "...", "role": "engineer" } }
401  wrong email or password, or the account is not active
403  the account is a viewer, or must first set a new password on the website
429  too many attempts; the Retry-After header says how many seconds to wait
```

- Same accounts and passwords as the website. No second user store.
- Send the token on every other call as **`Authorization: Bearer <token>`**.
  (`X-Session-Id: <token>` also works from a native build, but browsers will not send it
  cross-origin, so use `Authorization` and the Expo web build works too.)
- Keep the token in `expo-secure-store`, not AsyncStorage.
- A phone sign-in is separate from the website: neither signs the other out. One phone per person:
  signing in on a second phone ends the first phone's token.
- The token dies after 30 days without use, on a password change, or on sign-out.
  **Any call answering 401 means: drop the token and show the sign-in screen.** Keep the queue of
  unsent scans; send it after the next sign-in.

```
GET  /api/mobile/me          -> { "user": { id, name, email, role } }     (401: sign in again)
POST /api/session/logout     {}  with the Authorization header            -> { "ok": true }
```

## Saving a scan

```
POST /api/scans      multipart/form-data
  image        file, required   JPEG, PNG or WebP, 8 MB at most
  thumbnail    file, optional   small JPEG (about 320 px wide), 512 KB at most
  pickNote     required, 60 chars at most
  description  required, 300 chars at most     (item description or code)
  quantity     required, a number above 0      ("2.5" and "2,5" both work)
  clientName   optional
  clientCode   optional
  capturedAt   optional ISO time the photo was taken (for scans that waited in the queue)
  clientRef    optional but strongly advised: 8-80 chars of A-Z a-z 0-9 . _ : -

201  the saved scan (shape below)
200  the same scan again, with "alreadySaved": true   (this clientRef was saved before)
400  a field is missing or wrong; the message says which
401  sign in again        403  viewers cannot save scans
413  the photo is over 8 MB
```

- **`clientRef`**: make one id per scan when the user presses Confirm (a UUID is fine) and keep it
  with the queued scan. Retry with the same id until you get 200 or 201. A 400 or 413 will never
  succeed on retry: show the message and let the user fix or discard the scan.
- **Photo size**: resize before sending (longest side about 1600 px, JPEG quality about 0.7, with
  `expo-image-manipulator`). That is 200-400 KB instead of several MB on a warehouse connection.
  **HEIC is refused** (browsers cannot show it): convert to JPEG.
- Do not set the `Content-Type` header yourself for the multipart call; let `fetch` add the boundary.
- The thumbnail is used in lists. Without one the full photo is served in its place.

The pick note number is matched, ignoring capitals and spaces, against Tracklab's sales order
numbers (`SO-2026-0004`) and delivery / collection note numbers (`DN-…`, `CN-…`). On a match the
scan is linked to that document and takes its client, and `pickNote` comes back in Tracklab's
spelling. With no match it is saved as typed and the links are `null`. Never an error.

## A scan

```json
{
  "id": 41,
  "pickNote": "SO-2026-0004",
  "clientName": "Acme",            "clientCode": "AC-1",
  "description": "Relay board",    "quantity": 3,
  "user": { "id": 7, "name": "Sam Nkosi", "email": "sam@example.com" },
  "capturedAt": "2026-11-16T08:12:00.000Z",
  "createdAt": "2026-11-16T08:12:09.512Z",
  "imageUrl": "/api/scans/41/image",
  "thumbUrl": "/api/scans/41/image?size=thumb",
  "client": { "id": 30, "name": "Acme (Pty) Ltd" },
  "clientOrder": { "id": 13, "number": "SO-2026-0004" },
  "dispatchNote": null
}
```

`clientName` / `clientCode` are what was typed on the phone; `client` is the Tracklab customer it
was linked to (or `null`). `imageUrl` and `thumbUrl` are paths: prefix the base URL, and send the
token. In React Native:

```jsx
<Image source={{ uri: API_URL + scan.thumbUrl, headers: { Authorization: `Bearer ${token}` } }} />
```

(On the web build an `<img>` cannot send headers: `fetch` the URL with the header and show a
`URL.createObjectURL(blob)`.) Photos never change, so they are served with a 7-day cache header.

## Reading scans

```
GET /api/scans?pickNote=&user=&client=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=30
    -> { "items": [scan, ...], "total": 57, "page": 1, "pageSize": 30 }
```

All filters are optional and combine. `pickNote`, `user` (name or email) and `client` (typed name,
typed code or linked customer) match any part, ignoring case. Dates are inclusive and compare the
time taken. Newest first. `pageSize` is 100 at most. Also accepted: `clientOrderId`, `dispatchNoteId`.

```
GET    /api/scans/:id               one scan (404 when gone)
GET    /api/scans/:id/image         the photo bytes;  ?size=thumb for the small one
DELETE /api/scans/:id               your own scan, or any as an admin (403 otherwise)
GET    /api/scans/lookup?pickNote=SO-2026-0004[&clientName=Acme]
       -> { "pickNote": "...", "matched": true,
            "clientOrder": { id, number } | null, "dispatchNote": { id, number, type } | null,
            "client": { id, name } | null }
```

Use `lookup` on the main screen to show "Sales order SO-2026-0004 · Acme" (or "not a Tracklab
number, will be saved as typed") before the user starts scanning. It is a hint, not a gate.

## Booking stock in and out

The main job of the app: scan a reel, packet or any other item in or out of stock. Each scan
waits on the website for approval before stock changes.
Needs a camera barcode scanner in the app (`expo-camera`, with `barcodeScannerSettings` for
`datamatrix`, `qr`, `code128`, `code39`, `ean13`). **Pass the scanned string through untouched**,
control characters included: the 2D code on reel labels uses them as field separators.
Server code: `src/lib/scanStock.ts`.

### 1. What is this code?

```
GET /api/stock-moves/find?code=<scanned or typed text, URL-encoded>

200 {
  "code": "…",
  "label": null | { "kind": "supplier-2d" | "supplier-qr", "partNumbers": ["CL10A106KP8NNNC", "296-1234-1-ND"],
                    "quantity": 4000, "lot": "LOT778899", "dateCode": "2535" },
  "matchedBy": "stock code" | "part number" | "search" | null,
  "exact": true,
  "items": [ {
    "partNumber": "CAP-024",            // Tracklab's stock code: send this back when booking
    "name": "10uF 0603 X5R", "description": "…", "makerPartNumber": "CL10A106KP8NNNC",
    "packaging": "reel", "status": "ACTIVE",
    "stock": 12000,
    "places": [ { "locationId": 4, "code": "REEL-RACK-2", "name": "Reel rack 2", "quantity": 8000 } ],
    "noLocation": 4000                  // in stock but not put away anywhere
  } ],
  "location": null | { "id": 4, "code": "REEL-RACK-2", "name": "Reel rack 2", "active": true }
}
```

Understood: a Tracklab stock code (any capitals); a maker's or supplier's part number saved on the
item; the 2D code on a supplier reel label (DigiKey, Mouser, most makers: starts `[)>`); the QR
code on an LCSC / JLCPCB bag (`{pbn:…,pc:C2040,pm:…,qty:10}`); a stock location's code; and, for
typed text of 3+ characters, a search of codes, names and part numbers (up to 10).

What to do with the answer:

- `exact: true` and one item: show it and go straight to the quantity. Pre-fill the quantity, lot
  and date code from `label` when present.
- several `items` (`exact: false`): let the user pick one. This happens when a part number is on
  more than one stock code, or the text was a search.
- `location` set and no items: the user scanned a shelf or rack label; use it as the place for
  the booking they are making.
- nothing, booking IN: `barcodes` lists the codes in the scan that can be remembered. Offer
  **Add as a new item** or **Link to an existing item** (see "Unknown labels" below).
- nothing, booking OUT: "Not in Tracklab, so there is nothing to book out."

`matchedBy` can also be `"barcode"`: a label linked to an item by an approved scan (below). Such a match is exact.

### 2. Send the scan (it waits for approval)

**A scan does not change stock.** It is saved as `PENDING` and shown on the website
(Sales > Scanner), where someone approves or rejects it. Stock changes on approval.

```
POST /api/stock-moves        JSON
{
  "direction":  "IN" | "OUT",
  "partNumber": "CAP-024",        // an item's partNumber from find
  "quantity":   4000,             // whole number, 1 or more
  "locationId": 4,                // optional
  "lot": "LOT778899", "dateCode": "2535",   // optional, booking IN only
  "reference":  "PO-2026-0007",   // optional: PO, job or order number
  "note":       "line 2",         // optional
  "capturedAt": "2026-11-17T08:12:00Z",     // optional, for scans that waited in the queue
  "clientRef":  "<one id per scan>"          // strongly advised, as for pick scans
}

201 { "id": 9, "status": "PENDING", "direction": "IN", "partNumber": "CAP-024", "itemName": "…",
      "quantity": 4000, "stockAfter": null, "stockNow": 12000,
      "location": { "id": 4, "code": "REEL-RACK-2" } | null,
      "lot": "…", "dateCode": "…", "reference": "…", "note": "…",
      "user": { id, name, email }, "capturedAt": "…", "createdAt": "…",
      "decidedBy": null, "decidedAt": null, "rejectReason": null }
200 the same scan again with "alreadySaved": true   (this clientRef was sent before)
400 a field is missing or wrong          404 that partNumber is not an item
403 this account may not change stock    401 sign in again
409 OUT for more than is in stock right now: "Only 35 of CAP-024 in stock."
```

- `status` is `PENDING`, then `APPROVED` (with `stockAfter`, `decidedBy`, `decidedAt`) or
  `REJECTED` (with `rejectReason` when one was given).
- On approval, **IN** adds to stock (put away at `locationId` when given, otherwise under
  "No location"); **OUT** takes from stock (from that place when given, otherwise stock with no
  location first, then the oldest places).
- **Retries**: same rule as pick scans. Keep the scan in the queue with its `clientRef` and resend
  until 200 or 201. Never resend without the same `clientRef`. A 400, 403, 404 or 409 will not
  succeed on retry: show the message.
- Show the user "Sent for approval", not "Booked".

### Unknown labels: a new item, or a barcode for an existing one

Both ride on the book-in above and happen **only when the scan is approved**; rejecting leaves nothing.

```
New item:   { "direction": "IN", "quantity": 4000, "code": "<what was scanned>",
              "newItem": { "partNumber": "CAP-099", "name": "10uF 0603 X5R 10V",
                           "makerPartNumber": "GRM188R61A106KE69D", "description": null }, ... }
Link:       { "direction": "IN", "partNumber": "CAP-024", "quantity": 4000,
              "code": "<what was scanned>", "saveBarcode": true, ... }
```

- `newItem.partNumber` is the new stock code (capitals; spaces become dashes). 409 when an item (even a
  deleted one) already has it: "CAP-099 is already an item (…). Choose another stock code, or link the label".
  Check first with `find?code=CAP-099` (`matchedBy: "stock code"` means taken).
- On approval the item is created (stock 0, ACTIVE, maker part number in the first slot), the codes in
  `code` (the label's part numbers, or the barcode text) are remembered on it, then the stock is booked in.
  If the stock code was taken meanwhile, approving fails with the same 409 and the scan stays pending.
- A scan carries `newItem` and `linkCodes` (the codes approving remembers) for the website to show.

### 3. My scans, and cancelling one

```
GET /api/stock-moves?mine=1&status=PENDING|APPROVED|REJECTED|DONE&direction=IN|OUT&part=&user=
                    &decidedBy=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=30
    -> { "items": [scan, ...], "total": 12, "pending": 3, "page": 1, "pageSize": 30 }
       mine=1: only the signed-in person's scans.  "pending": how many are waiting, over everyone.
       status=DONE: the history, approved and rejected together.  decidedBy: who approved or rejected (name or email).

POST /api/stock-moves/decide   { "ids": [9], "decision": "REJECT", "reason": "Cancelled on the phone" }
    -> { "results": [{ "id": 9, "ok": true, "move": scan } | { "id": 9, "ok": false, "error": "Already approved by …" }],
         "done": 1, "failed": 0 }
       The same call with "decision": "APPROVE" is what the website's Approve button sends.

GET /api/stock-locations     -> { "locations": [{ id, code, name, active, … }], … }, for a "choose a place" list.
                                Many items have a location named after their own stock code.
```

Poll `mine=1` (every 15 s while the app is open) to show each scan turning Approved or Rejected.

### Suggested screens

Tracklab's own phone page does exactly this and is the reference to copy:
`https://tracklab-im.fly.dev/scan`, source in `src/scan/` (`ScanApp.tsx`, `CodeScanner.tsx`, `api.ts`).

1. Sign in. Then a **Book in / Book out** switch at the top, and Receive a PO / Pick a kit / Count stock.
2. **Scan a label** (camera) with a "type it instead" box → `find` → item card (name, stock, where
   it is) → quantity (pre-filled from the label) → optional place (scan a rack label or pick from
   the list) → optional reference → **Send for approval** → back to the scanner for the next reel.
3. **My scans** underneath: each with Waiting for approval / Approved / Rejected, and Cancel on
   the waiting ones.
### Jobs: receiving a PO, picking a kit, counting

```
GET /api/stock-moves/purchase-orders          -> { items: [{ id, number, status, supplier, orderDate, expectedDate, lines, outstanding }] }
                                                 draft, sent and part-received orders
GET /api/stock-moves/purchase-orders/:id      -> { id, number, status, supplier, expectedDate,
                                                   lines: [{ id, partNumber, inTracklab, name, description, quantity, received, waiting }] }
GET /api/stock-moves/kits                     -> { items: [{ id, name, buildQty, project, lines }] }
GET /api/stock-moves/kits/:id                 -> { id, name, buildQty, project,
                                                   lines: [{ code, need, forLines, item (as find's items), waiting, bookedOut }] }
```

- Receiving: send the scan as usual (`direction: "IN"`) with `poItemId` (a line's `id`). Refused
  (400) when the item isn't that line's part, 409 when the order is received or cancelled.
  Approving adds the quantity to the line's received and sets the order PARTIAL / RECEIVED.
- Picking: `direction: "OUT"` with `kitId`. Refused (400) when the item isn't on the kit's pick list.
- With either, an empty `reference` becomes the PO number / "Kit <name>". A scan in the lists carries
  `po: { id, number, itemId } | null` and `kit: { id, name } | null`.
- Counting uses the website's stock count routes: `GET /api/stock-counts` (open ones have
  `status: "OPEN"`), `POST /api/stock-counts { scope: "location", locationId }`,
  `GET /api/stock-counts/:id`, `PUT /api/stock-counts/:id/lines { lines: [{ id, counted }] }`,
  `POST /api/stock-counts/:id/lines { serialNumber, locationId? }`. Posting stays on the website.

### Tracklab's own labels

`find` reads them: a bin label `LOC:A1-03` is that location (`location`, no items); a reel label
`TL:CAP-024?lot=L1&dc=2431&qty=4000&at=A1-03` (a QR code; values URL-encoded, all optional) is the
item, with `label: { kind: "tracklab", quantity, lot, dateCode, place }`.

## Not built

- Moving stock between locations from the phone (the website does this under Stock locations).
- Editing a saved scan: delete it and scan again.
