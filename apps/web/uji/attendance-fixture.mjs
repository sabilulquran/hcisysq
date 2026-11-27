// Dev-only fixture for the employee attendance screen (/app/attendance).
//
// NOT part of any build: `vite.config.ts` mounts it as dev middleware only when UJI_KEHADIRAN=1
// or the untracked marker `uji/aktif` exists, and when it is mounted the /api proxy to the real
// API is switched off, so this dev server can only ever reach synthetic data.
//
// It exists because the design evidence for this screen needs states a database cannot be asked
// for on demand — an empty history, a failing transactions call, a scan that landed after the
// calculation — at three viewports, and because a signed-in session is not available offline.
//
// Every figure is invented. No production data, no real employee, no network call leaves the host.

const DAY = 86_400_000;

function jakartaDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date(Date.now() + offsetDays * DAY));
}

/** An ISO instant at a Jakarta wall-clock time on a work date. */
function at(workDate, hours, minutes) {
  const [y, m, d] = workDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hours, minutes) - 7 * 60 * 60_000).toISOString();
}

function schedule(workDate, state = "scheduled") {
  return {
    state,
    scheduleTemplateId: state === "scheduled" ? "tmpl-uji" : null,
    rosterId: null,
    scheduledStartAt: state === "scheduled" ? at(workDate, 7, 0) : null,
    scheduledEndAt: state === "scheduled" ? at(workDate, 16, 0) : null,
    workLocation: state === "scheduled"
      ? { id: "loc-uji", name: "Kampus Utama", latitude: -7.1, longitude: 112.7, radiusMeters: 120 }
      : null,
  };
}

function result(workDate, over = {}) {
  return {
    id: `res-${workDate}`, workDate, version: 1, status: "present",
    scheduledStartAt: at(workDate, 7, 0), scheduledEndAt: at(workDate, 16, 0),
    firstCheckInAt: at(workDate, 7, 4), lastCheckOutAt: at(workDate, 16, 12),
    workedMinutes: 488, breakMinutes: 60, lateMinutes: 0, earlyLeaveMinutes: 0,
    incompleteSession: false, justified: false, lateJustified: false,
    earlyLeaveJustified: false, outsideGeofenceJustified: false, overtimeMinutes: 0,
    sessions: [
      { sequence: 1, checkInAt: at(workDate, 7, 4), checkOutAt: at(workDate, 12, 0), workedMinutes: 296, complete: true },
      { sequence: 2, checkInAt: at(workDate, 13, 0), checkOutAt: at(workDate, 16, 12), workedMinutes: 192, complete: true },
    ],
    ...over,
  };
}

/** Weekdays carry a schedule; the two most recent are deliberately left uncalculated. */
function historyRange(from, to, mode) {
  // "kosong" is the real empty state of this screen: no day on record at all.
  if (mode === "kosong") return [];
  const items = [];
  const end = new Date(to + "T00:00:00Z");
  for (let cursor = new Date(from + "T00:00:00Z"); cursor <= end; cursor = new Date(cursor.getTime() + DAY)) {
    const workDate = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      items.push({ workDate, schedule: schedule(workDate, "off"), result: null, pendingScans: null });
      continue;
    }
    const age = Math.round((end - cursor) / DAY);
    if (age <= 1) {
      items.push({ workDate, schedule: schedule(workDate), result: null, pendingScans: { firstScanAt: at(workDate, 7, 2), lastScanAt: at(workDate, 16, 20), scanCount: 2 } });
      continue;
    }
    const late = age % 7 === 3;
    items.push({
      workDate,
      schedule: schedule(workDate),
      result: result(workDate, late ? { status: "late", lateMinutes: 24, firstCheckInAt: at(workDate, 7, 24), workedMinutes: 464 } : {}),
      pendingScans: null,
    });
  }
  return items;
}

function transactionsFor(items, mode) {
  const days = []; const list = [];
  for (const item of items) {
    if (item.schedule.state !== "scheduled" || mode === "kosong") continue;
    const first = item.result?.firstCheckInAt ?? item.pendingScans?.firstScanAt ?? null;
    const last = item.result?.lastCheckOutAt ?? item.pendingScans?.lastScanAt ?? null;
    if (!first) continue;
    // One calculated date carries a scan that landed afterwards, so "Ada scan baru" is real.
    const newSince = item.result !== null && days.filter((d) => d.calculatedAt).length === 1;
    days.push({
      workDate: item.workDate, firstScanAt: first, lastScanAt: last,
      scanCount: newSince ? 3 : 2,
      calculatedAt: item.result ? at(item.workDate, 18, 0) : null,
      newSinceCalculation: newSince,
    });
    list.push({ occurredAt: first, workDate: item.workDate, source: "adms", kind: "check_in", deviceName: "Lobi Utama", reviewState: null, afterCalculation: false });
    if (last) list.push({ occurredAt: last, workDate: item.workDate, source: "adms", kind: "check_out", deviceName: "Lobi Utama", reviewState: null, afterCalculation: false });
    if (newSince) list.push({ occurredAt: at(item.workDate, 19, 5), workDate: item.workDate, source: "mobile", kind: null, deviceName: null, reviewState: "needs_review", afterCalculation: true });
  }
  return { days, list };
}

/**
 * `?uji=<mode>` on the page picks the state; the mode is remembered per browser session so the
 * app's own fetches (which carry no query of their own) stay in it.
 *   terisi (default) · kosong · error · lambat
 */
export function attendanceFixture() {
  let mode = "terisi";
  return {
    name: "uji-kehadiran",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const asked = url.searchParams.get("uji");
        if (asked) mode = asked;
        if (!url.pathname.startsWith("/api/")) return next();

        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        };
        const today = jakartaDate();
        const from = jakartaDate(-29);

        if (url.pathname === "/api/auth/me") {
          return send(200, {
            principal: { id: "uji-1", email: "pegawai@uji.invalid", principalType: "EMPLOYEE" },
            expiresAt: "2099-01-01T00:00:00Z",
            authorization: { organizationPermissions: [] },
          });
        }

        if (url.pathname === "/api/attendance/me/workforce") {
          const mine = historyRange(from, today, mode);
          // With no day on record the screen still has a today: scheduled, nothing scanned.
          const todayRow = mine[mine.length - 1] ?? { schedule: schedule(today), result: null };
          return send(200, {
            employee: { id: "uji-1", fullName: "Pegawai Uji", employeeNumber: "000000" },
            workDate: today,
            mobileEnabled: true,
            mobileReadiness: { captureReady: true, captureReason: "ready", scheduleState: todayRow.schedule.state, scheduleReason: null, hasWorkLocation: true, workLocationId: "loc-uji", workLocationSource: "shift" },
            schedule: todayRow.schedule,
            result: todayRow.result,
            clarifications: [],
            overtimeRequests: mode === "kosong" ? [] : [
              { id: "ot-1", workDate: jakartaDate(-2), requestedMinutes: 90, approvedMinutes: null, note: "Menyiapkan laporan bulanan", status: "submitted", decisionNote: null, createdAt: at(jakartaDate(-2), 17, 0), decidedAt: null, initiatedBy: "employee", supervisorName: "Atasan Uji", awaiting: "supervisor" },
              { id: "ot-2", workDate: jakartaDate(-4), requestedMinutes: 60, approvedMinutes: 60, note: null, status: "approved", decisionNote: "Disetujui penuh", createdAt: at(jakartaDate(-4), 17, 0), decidedAt: at(jakartaDate(-3), 9, 0), initiatedBy: "employee", supervisorName: "Atasan Uji", awaiting: null },
              { id: "ot-3", workDate: jakartaDate(-1), requestedMinutes: 120, approvedMinutes: null, note: "Piket akhir pekan", status: "submitted", decisionNote: null, createdAt: at(jakartaDate(-1), 8, 0), decidedAt: null, initiatedBy: "supervisor", supervisorName: "Atasan Uji", awaiting: "employee" },
            ],
            mobileEvidence: [],
          });
        }

        if (url.pathname === "/api/attendance/me/schedule") {
          return send(200, { items: historyRange(url.searchParams.get("from") ?? from, url.searchParams.get("to") ?? today, mode) });
        }

        if (url.pathname === "/api/attendance/me/transactions") {
          if (mode === "error") return send(503, { code: "UJI_ERROR", message: "Layanan transaksi sedang tidak dapat dihubungi." });
          if (mode === "lambat") return; // never answers, so the loading state stays on screen
          const { days, list } = transactionsFor(historyRange(from, today, mode), mode);
          return send(200, { from, to: today, generatedAt: new Date().toISOString(), truncated: false, items: list, days });
        }

        if (url.pathname === "/api/attendance/clarifications/me") {
          if (mode === "kosong") return send(200, { items: [] });
          return send(200, { items: [
            { id: "kl-1", workDate: jakartaDate(-3), kind: "lateness", mode: "justification", reason: "Menunggu jemputan", status: "submitted", proposedCheckInAt: null, proposedCheckOutAt: null, decisionNote: null, createdAt: at(jakartaDate(-3), 17, 30) },
            { id: "kl-2", workDate: jakartaDate(-6), kind: "missing_check_out", mode: "correction", reason: "Lupa scan pulang", status: "approved", proposedCheckInAt: null, proposedCheckOutAt: at(jakartaDate(-6), 16, 10), decisionNote: "Dikoreksi HC", createdAt: at(jakartaDate(-6), 18, 0) },
          ] });
        }

        // Writes answer success without storing anything: the flows are exercised, nothing persists.
        if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
          if (url.pathname.endsWith("/overtime") || url.pathname.includes("/overtime")) return send(200, { warnings: [] });
          return send(200, { ok: true });
        }

        return send(200, {});
      });
    },
  };
}
