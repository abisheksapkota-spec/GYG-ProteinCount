# Protein Count

🔗 https://abisheksapkota-spec.github.io/GYG-ProteinCount/


A one-hand closing stock count for kitchen cooks. Count six proteins in the cold room,
let the app do the maths, and submit the report to the manager in about five minutes.

Open `index.html` in a phone browser. No install needed.

## Closing flow
1. **Start closing count.** The date, time and your name are recorded.
2. **Pick a protein** from the six tiles: Chicken, Ground Beef, Brisket, BBQ Beef Rib, Pulled Pork, Avocado.
3. **Count with + / −.** Each protein has rows for **prep containers** (halves allowed, e.g. 2.5), **open packets** and **boxes** (whole numbers only). The app multiplies by the weight of one and shows the working, e.g. `3 × 16 kg = 48.00 kg`.
   - Prep counts as *prepared* stock. Packets and boxes count as *unopened*.
   - **Weigh odd leftovers** is a backup: type a scale reading, pick the container, and its empty weight is subtracted (8.50 − 0.50 = 8.00 kg). Edit, or delete with Undo.
   - **None in stock** marks a protein as 0 kg.
4. **Done · Next** jumps to the next pending protein. The home screen shows `3 / 6` progress and the total kg.
5. **Review & submit.** The review table shows prepared, unopened and total per protein, plus anything missing. Submitting with missing proteins asks first.
6. **Previous** lists earlier closing counts, with the change since the count before.

## Reliability
- Every tap is auto-saved on the phone, including a weight typed but not yet added. Closing the app or losing signal loses nothing.
- Works without signal once open. Reports that can't be sent are kept and resent when back online.
- Weights must be numbers above 0 and at most 100 kg. Negative numbers, and a container heavier than the reading, are rejected.

## Weights menu
Weights are saved and used for every count. Change them only when a box or container size changes. The count screen links straight to them.

**Count weights:** the weight in kg of one prep container, one open packet and one box, for each protein. Leave it blank if a protein doesn't come that way. Defaults:

| Protein | Prep container | Open packet | Box |
|---|---|---|---|
| Chicken | 7.5 | not used | 7.5 |
| Ground Beef, Brisket, Pulled Pork, BBQ Beef Rib | 6 (3 packets) | 2 | 16 (8 packets) |
| Avocado | not used | not used | set it in **Weights** (boxes only) |

**Empty containers for weighing:** only needed for the weigh-leftovers backup.

On the hosted page, the owner's **Save weights** applies to everyone with the link. If a counted protein has no weight set, submitting warns first.

## Project files
| File | What it is |
|---|---|
| `index.html` | The whole app: one self-contained page (HTML, CSS and JavaScript, no build step) |
| `tests/acceptance.js` | Automated acceptance tests (counts, half containers, validation, auto-save, submit warnings, report) |
| `package.json` | Scripts for running and testing |

## Run it
- **Simplest:** open `index.html` in a browser.
- **Local server:** `npm start`, then open the address it prints.
- **Free hosting:** push to GitHub, then **Settings → Pages → Deploy from branch → main / root**. Staff open the link and use **Add to Home Screen**.

When opened as a plain page, counts, history and weights are saved on each phone. Sending reports to a manager and sharing weights with everyone use the hosted Claude artifact version. A company rollout would need its own backend (see *Roadmap*).

## Tests
```bash
npm install
npx playwright install chromium
npm test
```
The tests run the real page in a simulated iPhone and print PASS or FAIL for each acceptance criterion.

## Roadmap
- Company logins and per-store accounts
- Hosted backend owned by the business, with a manager dashboard across stores
- Export into the existing stock or ordering system
- Installable offline app (PWA)
- Barcode scanning and Bluetooth scale input
