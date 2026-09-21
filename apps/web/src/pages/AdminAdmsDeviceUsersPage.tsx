import { AlertTriangle, Link2, Loader2, RefreshCw, Search, UserRoundCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  cancelAdmsPinCorrection,
  getAdmsDeviceRoster,
  getAdmsMappingAssistant,
  listAdmsUserCorrections,
  planAdmsPinCorrection,
  syncAdmsUserName,
  type AdmsMappingAssistantItem,
  type AdmsMappingLifecycleItem,
  type AdmsRosterItem,
  type AdmsUserCorrectionItem,
} from "@/lib/admsAdmin";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import { hasPermission } from "@/lib/authorization";
import { employeeLifecycleLabel, mappedEmployeeNeedsReview } from "@/lib/admsUserState";
import { createAdmsMapping, endAdmsMapping } from "@/lib/attendance";

type UserRow = {
  pin: string;
  displayName: string | null;
  cardNumber: string | null;
  lastSeenAt: string | null;
  eventCount: number;
  rosterObserved: boolean;
  mappingId: string | null;
  employeeId: string | null;
  employeeNumber: string | null;
  employeeName: string | null;
  employeeStatus: string | null;
  assistant: AdmsMappingAssistantItem | null;
};

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function candidateLabel(kind: string) {
  if (kind === "exact_name") return "Nama sama";
  if (kind === "close_name") return "Sangat mirip";
  return "Mirip";
}

export function AdminAdmsDeviceUsersPage() {
  const { deviceId, detail, refresh: refreshDevice, session, sessionResolved } = useDeviceAdmin();
  const canOperate = hasPermission(session, "attendance.devices.operate");
  const canSearchEmployees = hasPermission(session, "employees.manage");
  const [roster, setRoster] = useState<AdmsRosterItem[]>([]);
  const [mappingLifecycle, setMappingLifecycle] = useState<AdmsMappingLifecycleItem[]>([]);
  const [assistantItems, setAssistantItems] = useState<AdmsMappingAssistantItem[]>([]);
  const [corrections, setCorrections] = useState<AdmsUserCorrectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mappingFilter, setMappingFilter] = useState<"all" | "mapped" | "unmapped">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [mappingTarget, setMappingTarget] = useState<UserRow | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employeeResults, setEmployeeResults] = useState<AdminEmployeeListItem[]>([]);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<UserRow | null>(null);
  const [intendedPin, setIntendedPin] = useState("");

  const load = useCallback(async () => {
    const [rosterResult, assistantResult, correctionResult] = await Promise.all([
      getAdmsDeviceRoster(deviceId),
      getAdmsMappingAssistant(deviceId),
      listAdmsUserCorrections(deviceId),
    ]);
    setRoster(rosterResult.items);
    setMappingLifecycle(rosterResult.mappingLifecycle.items);
    setAssistantItems(assistantResult.items);
    setCorrections(correctionResult.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load()
      .then(() => setError(null))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Data pengguna mesin tidak dapat dimuat.");
      })
      .finally(() => setLoading(false));
  }, [load]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(), refreshDevice()]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data pengguna mesin tidak dapat dimuat ulang.");
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshDevice]);

  const rows = useMemo<UserRow[]>(() => {
    const result = new Map<string, UserRow>();
    for (const observed of detail?.observedPins ?? []) {
      result.set(observed.pin, {
        pin: observed.pin,
        displayName: null,
        cardNumber: null,
        lastSeenAt: observed.lastEventAt,
        eventCount: observed.eventCount,
        rosterObserved: false,
        mappingId: observed.mappingId,
        employeeId: observed.employeeId,
        employeeNumber: observed.employeeNumber,
        employeeName: observed.employeeName,
        employeeStatus: null,
        assistant: null,
      });
    }
    for (const item of roster) {
      const current = result.get(item.pin);
      result.set(item.pin, {
        pin: item.pin,
        displayName: item.displayName,
        cardNumber: item.cardNumber,
        lastSeenAt: item.lastSeenAt,
        eventCount: current?.eventCount ?? 0,
        rosterObserved: true,
        mappingId: item.mappingId ?? current?.mappingId ?? null,
        employeeId: item.employeeId ?? current?.employeeId ?? null,
        employeeNumber: item.employeeNumber ?? current?.employeeNumber ?? null,
        employeeName: item.employeeName ?? current?.employeeName ?? null,
        employeeStatus: item.employeeStatus,
        assistant: current?.assistant ?? null,
      });
    }
    for (const item of mappingLifecycle) {
      const current = result.get(item.pin);
      result.set(item.pin, {
        pin: item.pin,
        displayName: current?.displayName ?? null,
        cardNumber: current?.cardNumber ?? null,
        lastSeenAt: current?.lastSeenAt ?? null,
        eventCount: current?.eventCount ?? 0,
        rosterObserved: current?.rosterObserved ?? false,
        mappingId: item.mappingId,
        employeeId: item.employeeId,
        employeeNumber: item.employeeNumber,
        employeeName: item.employeeName,
        employeeStatus: item.employeeStatus,
        assistant: current?.assistant ?? null,
      });
    }
    for (const item of assistantItems) {
      const current = result.get(item.pin);
      result.set(item.pin, {
        pin: item.pin,
        displayName: current?.displayName ?? item.rosterDisplayName,
        cardNumber: current?.cardNumber ?? item.cardNumber,
        lastSeenAt: current?.lastSeenAt ?? item.rosterObservedAt ?? item.lastEventAt,
        eventCount: Math.max(current?.eventCount ?? 0, item.eventCount),
        rosterObserved: current?.rosterObserved ?? Boolean(item.rosterObservedAt),
        mappingId: current?.mappingId ?? null,
        employeeId: current?.employeeId ?? null,
        employeeNumber: current?.employeeNumber ?? null,
        employeeName: current?.employeeName ?? null,
        employeeStatus: current?.employeeStatus ?? null,
        assistant: item,
      });
    }
    return Array.from(result.values()).sort((a, b) => a.pin.localeCompare(b.pin, "id", { numeric: true }));
  }, [assistantItems, detail?.observedPins, mappingLifecycle, roster]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    return rows.filter((row) => {
      const mapped = Boolean(row.mappingId && row.employeeId);
      if (mappingFilter === "mapped" && !mapped) return false;
      if (mappingFilter === "unmapped" && mapped) return false;
      if (!needle) return true;
      return [row.pin, row.displayName, row.cardNumber, row.employeeName, row.employeeNumber]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("id-ID").includes(needle));
    });
  }, [mappingFilter, query, rows]);

  useEffect(() => {
    setPage(1);
  }, [deviceId, mappingFilter, pageSize, query]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filteredRows.length, page, pageSize]);

  const pagedRows = useMemo(
    () => filteredRows.slice((page - 1) * pageSize, page * pageSize),
    [filteredRows, page, pageSize],
  );

  const plannedByPin = useMemo(
    () => new Map(corrections.filter((item) => item.status === "planned").map((item) => [item.legacyPin, item])),
    [corrections],
  );
  const mappedEmployeeIds = useMemo(
    () => new Set(rows.map((row) => row.employeeId).filter((value): value is string => Boolean(value))),
    [rows],
  );
  const mappedCount = rows.filter((row) => row.mappingId && row.employeeId).length;
  const unmappedCount = rows.length - mappedCount;
  const reviewCount = rows.filter((row) => mappedEmployeeNeedsReview(row)).length;

  const mapEmployee = useCallback(async (row: UserRow, employee: Pick<AdminEmployeeListItem, "id" | "employeeNumber" | "fullName">) => {
    const confirmed = window.confirm(
      `Hubungkan PIN ${row.pin} (${row.displayName ?? "nama mesin belum teramati"}) ke ${employee.fullName} (${employee.employeeNumber})?\n\nIni keputusan eksplisit Admin. Kemiripan nama hanya rekomendasi dan tidak pernah membuat mapping otomatis.`,
    );
    if (!confirmed) return;
    setBusyKey(`map:${row.pin}`);
    try {
      await createAdmsMapping(deviceId, { pin: row.pin, employeeId: employee.id });
      setNotice(`PIN ${row.pin} berhasil dihubungkan ke ${employee.fullName}.`);
      setMappingTarget(null);
      setEmployeeResults([]);
      setEmployeeQuery("");
      setError(null);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hubungan PIN tidak dapat disimpan.");
    } finally {
      setBusyKey(null);
    }
  }, [deviceId, refreshAll]);

  const searchEmployees = useCallback(async () => {
    const q = employeeQuery.trim();
    if (!q) {
      setEmployeeResults([]);
      return;
    }
    setEmployeeLoading(true);
    try {
      const result = await listEmployees({ q, status: "active", page: 1, pageSize: 20 });
      setEmployeeResults(result.items.filter((item) => !mappedEmployeeIds.has(item.id)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pencarian pegawai tidak dapat dimuat.");
    } finally {
      setEmployeeLoading(false);
    }
  }, [employeeQuery, mappedEmployeeIds]);

  const syncName = useCallback(async (row: UserRow) => {
    if (!row.employeeName || !row.rosterObserved || mappedEmployeeNeedsReview(row)) return;
    const sameValue = row.displayName === row.employeeName;
    const confirmed = window.confirm(
      sameValue
        ? `Kirim ulang nama "${row.employeeName}" ke PIN ${row.pin} sebagai sinkronisasi aman? PIN, kartu, dan biometrik tidak diubah.`
        : `Samakan nama PIN ${row.pin} dari "${row.displayName ?? "—"}" menjadi "${row.employeeName}"? PIN, kartu, dan biometrik tidak diubah.`,
    );
    if (!confirmed) return;
    setBusyKey(`sync:${row.pin}`);
    try {
      const result = await syncAdmsUserName(deviceId, row.pin);
      setNotice(`Perintah C:${result.item.commandNumber} untuk menyinkronkan nama PIN ${row.pin} sudah dibuat. Pantau hasilnya di tab Perintah.`);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sinkronisasi nama tidak dapat dibuat.");
    } finally {
      setBusyKey(null);
    }
  }, [deviceId, load]);

  const disconnectMapping = useCallback(async (row: UserRow) => {
    if (!row.mappingId || !row.employeeName) return;
    if (!window.confirm(`Akhiri hubungan PIN ${row.pin} dengan ${row.employeeName}? Riwayat mapping tetap dipertahankan.`)) return;
    setBusyKey(`unmap:${row.pin}`);
    try {
      await endAdmsMapping(row.mappingId);
      setNotice(`Hubungan aktif PIN ${row.pin} dengan ${row.employeeName} sudah diakhiri.`);
      setError(null);
      await refreshAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hubungan PIN tidak dapat diakhiri.");
    } finally {
      setBusyKey(null);
    }
  }, [refreshAll]);

  const saveCorrection = useCallback(async () => {
    if (!correctionTarget || !correctionTarget.rosterObserved || mappedEmployeeNeedsReview(correctionTarget)) return;
    const target = intendedPin.trim();
    if (!/^\d{1,128}$/.test(target) || target === correctionTarget.pin) {
      setError("PIN yang seharusnya harus berupa angka dan berbeda dari PIN mesin saat ini.");
      return;
    }
    if (!window.confirm(`Simpan rencana koreksi ${correctionTarget.pin} → ${target}? Mesin tidak akan diubah.`)) return;
    setBusyKey(`correction:${correctionTarget.pin}`);
    try {
      await planAdmsPinCorrection(deviceId, correctionTarget.pin, target);
      setNotice(`Rencana koreksi ${correctionTarget.pin} → ${target} tersimpan. Mesin belum diubah.`);
      setCorrectionTarget(null);
      setIntendedPin("");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rencana koreksi PIN tidak dapat disimpan.");
    } finally {
      setBusyKey(null);
    }
  }, [correctionTarget, deviceId, intendedPin, load]);

  const cancelCorrection = useCallback(async (item: AdmsUserCorrectionItem) => {
    if (!window.confirm(`Batalkan rencana koreksi ${item.legacyPin} → ${item.intendedPin}?`)) return;
    setBusyKey(`cancel-correction:${item.id}`);
    try {
      await cancelAdmsPinCorrection(item.id);
      setNotice(`Rencana koreksi ${item.legacyPin} → ${item.intendedPin} dibatalkan.`);
      setCorrectionTarget(null);
      setIntendedPin("");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rencana koreksi PIN tidak dapat dibatalkan.");
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-brand-heading">Pengguna mesin</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Tinjau PIN yang pernah teramati atau sudah mempunyai hubungan eksplisit di HCIS, lalu kelola mapping tanpa menebak isi lengkap mesin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing || loading}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Memuat…" : "Muat ulang"}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-surface px-3 py-1.5 font-semibold text-brand-heading">{rows.length} PIN dikenal HCIS</span>
          <span className="rounded-full bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700">{mappedCount} terhubung</span>
          <span className="rounded-full bg-amber-50 px-3 py-1.5 font-semibold text-amber-800">{unmappedCount} belum terhubung</span>
          {reviewCount > 0 ? (
            <span className="rounded-full bg-orange-50 px-3 py-1.5 font-semibold text-orange-800">{reviewCount} hubungan perlu ditinjau</span>
          ) : null}
          {corrections.some((item) => item.status === "planned") ? (
            <span className="rounded-full bg-sky-50 px-3 py-1.5 font-semibold text-sky-700">
              {corrections.filter((item) => item.status === "planned").length} rencana koreksi PIN
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cari PIN, nama, kartu, atau pegawai HCIS"
              className="h-10 w-full rounded-xl border border-border bg-white pl-9 pr-3 text-sm outline-none focus:border-brand-primary"
            />
          </label>
          <select
            value={mappingFilter}
            onChange={(event) => setMappingFilter(event.target.value as typeof mappingFilter)}
            className="h-10 rounded-xl border border-border bg-white px-3 text-sm text-brand-heading"
            aria-label="Filter hubungan pegawai"
          >
            <option value="all">Semua status</option>
            <option value="mapped">Sudah terhubung</option>
            <option value="unmapped">Belum terhubung</option>
          </select>
        </div>

        {sessionResolved && !canOperate ? (
          <div className="mt-4 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">
            Mode baca saja. Menghubungkan PIN, sinkronisasi nama, koreksi PIN, dan mengakhiri mapping memerlukan izin operasi perangkat.
          </div>
        ) : null}
        {notice ? <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}
        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        {loading ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Memuat pengguna mesin…
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Tidak ada pengguna yang cocok dengan filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="border-b border-border/70 bg-surface/70 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-bold">PIN</th>
                  <th className="px-4 py-3 font-bold">Data di mesin</th>
                  <th className="px-4 py-3 font-bold">Pegawai HCIS</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Terakhir teramati</th>
                  <th className="px-4 py-3 text-right font-bold">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedRows.map((row) => {
                  const mapped = Boolean(row.mappingId && row.employeeId);
                  const mappingReview = mappedEmployeeNeedsReview(row);
                  const plan = plannedByPin.get(row.pin) ?? null;
                  return (
                    <tr key={row.pin} className="align-top hover:bg-surface/40">
                      <td className="px-4 py-4">
                        <div className="font-mono text-xs font-bold text-brand-heading">{row.pin}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">{row.eventCount} punch tersimpan</div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="font-semibold text-brand-heading">{row.displayName ?? "Nama belum teramati"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">Kartu {row.cardNumber ?? "—"}</div>
                        {!row.rosterObserved ? <div className="mt-1 text-[11px] font-medium text-amber-700">Metadata pengguna belum teramati</div> : null}
                      </td>
                      <td className="px-4 py-4">
                        {mapped ? (
                          <>
                            <div className="font-semibold text-brand-heading">{row.employeeName ?? "Pegawai terhubung"}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{row.employeeNumber ?? "—"}</div>
                            {mappingReview ? (
                              <div className="mt-1 text-[11px] font-semibold text-orange-800">{employeeLifecycleLabel(row.employeeStatus)} · tinjau hubungan ini</div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">Belum terhubung</span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <div className="space-y-1.5">
                          <span className={mappingReview
                            ? "inline-flex rounded-full bg-orange-50 px-2 py-1 text-[11px] font-semibold text-orange-800"
                            : mapped
                              ? "inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700"
                              : "inline-flex rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800"}
                          >
                            {mappingReview ? "Perlu ditinjau" : mapped ? "Terhubung" : "Belum terhubung"}
                          </span>
                          {plan ? (
                            <div className="text-[11px] font-medium text-sky-700">Rencana PIN {plan.legacyPin} → {plan.intendedPin}</div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-xs text-muted-foreground">{fmt(row.lastSeenAt)}</td>
                      <td className="px-4 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {!mapped && canOperate ? (
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() => {
                                setMappingTarget(row);
                                setEmployeeQuery("");
                                setEmployeeResults([]);
                              }}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              <Link2 className="h-3.5 w-3.5" /> Hubungkan
                            </button>
                          ) : null}
                          {mapped && canOperate ? <details className="relative text-left">
                            <summary className="flex h-8 cursor-pointer list-none items-center rounded-lg border border-border bg-white px-3 text-xs font-semibold hover:bg-surface">
                              Aksi
                            </summary>
                            <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-border bg-white p-1.5 shadow-lg">
                              {mapped ? (
                                <>
                                  {mappingReview ? (
                                    <div className="rounded-lg bg-orange-50 px-3 py-2 text-[11px] leading-4 text-orange-900">
                                      Pegawai HCIS sudah tidak aktif. Akhiri hubungan jika mapping ini tidak lagi berlaku.
                                    </div>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={busyKey !== null || mappingReview || !row.employeeName || !row.rosterObserved}
                                    onClick={() => void syncName(row)}
                                    className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium hover:bg-surface disabled:opacity-50"
                                  >
                                    Sinkronkan nama
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busyKey !== null || mappingReview || !row.rosterObserved}
                                    onClick={() => {
                                      setCorrectionTarget(row);
                                      setIntendedPin(plan?.intendedPin ?? "");
                                    }}
                                    className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium hover:bg-surface disabled:opacity-50"
                                  >
                                    Koreksi PIN
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busyKey !== null}
                                    onClick={() => void disconnectMapping(row)}
                                    className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                                  >
                                    Akhiri hubungan
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </details> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={filteredRows.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
        <div className="border-t border-border/70 bg-surface/50 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
          Workspace ini menggabungkan PIN dari punch, metadata pengguna aman yang pernah teramati secara pasif, dan mapping eksplisit HCIS. PIN yang tidak terlihat di sini tidak membuktikan pengguna sudah tidak ada di mesin.
        </div>
      </section>

      {canOperate && mappingTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="mapping-dialog-title">
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="mapping-dialog-title" className="text-base font-bold text-brand-heading">Hubungkan PIN {mappingTarget.pin}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Pilih pegawai secara eksplisit. Rekomendasi diurutkan hanya dari kemiripan nama; nomor PIN, kartu, NIP, unit, dan identifier lain tidak dipakai untuk menebak identitas.
                </p>
              </div>
              <button type="button" onClick={() => setMappingTarget(null)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-border/70 bg-surface p-3">
              <div className="text-xs text-muted-foreground">Nama di mesin</div>
              <div className="mt-1 font-semibold text-brand-heading">{mappingTarget.displayName ?? "Belum teramati"}</div>
            </div>

            <div className="mt-5">
              <div className="flex items-center gap-2 text-xs font-bold text-brand-heading"><UserRoundCheck className="h-4 w-4" /> Rekomendasi nama</div>
              <div className="mt-2 space-y-2">
                {(mappingTarget.assistant?.candidates ?? []).map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void mapEmployee(mappingTarget, {
                      id: candidate.id,
                      employeeNumber: candidate.employeeNumber,
                      fullName: candidate.fullName,
                    })}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 p-3 text-left hover:bg-surface disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-brand-heading">{candidate.fullName}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {candidate.employeeNumber}{candidate.unitName ? ` · ${candidate.unitName}` : ""}{candidate.positionName ? ` · ${candidate.positionName}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                      {candidateLabel(candidate.matchKind)} · {candidate.similarity}/100
                    </span>
                  </button>
                ))}
                {(mappingTarget.assistant?.candidates.length ?? 0) === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-4 text-xs leading-5 text-muted-foreground">
                    Belum ada rekomendasi nama yang cukup dekat. Admin tetap dapat mencari pegawai secara manual jika identitasnya sudah diketahui.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-5 border-t border-border/70 pt-5">
              <div className="text-xs font-bold text-brand-heading">Cari pegawai manual</div>
              {canSearchEmployees ? <form
                className="mt-2 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchEmployees();
                }}
              >
                <input
                  value={employeeQuery}
                  onChange={(event) => setEmployeeQuery(event.target.value)}
                  placeholder="Nama atau nomor pegawai"
                  className="h-10 min-w-0 flex-1 rounded-xl border border-border px-3 text-sm outline-none focus:border-brand-primary"
                />
                <button
                  type="submit"
                  disabled={employeeLoading || !employeeQuery.trim()}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50"
                >
                  {employeeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Cari
                </button>
              </form> : (
                <div className="mt-2 rounded-xl bg-surface p-3 text-xs leading-5 text-muted-foreground">
                  Pencarian direktori pegawai memerlukan izin pengelolaan pegawai. Rekomendasi nama yang sudah dihitung tetap dapat dipakai bila tersedia.
                </div>
              )}
              <div className="mt-2 space-y-2">
                {employeeResults.map((employee) => (
                  <button
                    key={employee.id}
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void mapEmployee(mappingTarget, employee)}
                    className="flex w-full items-center justify-between rounded-xl border border-border/70 p-3 text-left hover:bg-surface disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-brand-heading">{employee.fullName}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{employee.employeeNumber}{employee.unitName ? ` · ${employee.unitName}` : ""}</span>
                    </span>
                    <span className="text-xs font-semibold text-brand-primary-deep">Pilih</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {canOperate && correctionTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="correction-dialog-title">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="correction-dialog-title" className="text-base font-bold text-brand-heading">Koreksi PIN {correctionTarget.pin}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Untuk {correctionTarget.employeeName ?? "pegawai terhubung"}</p>
              </div>
              <button type="button" onClick={() => setCorrectionTarget(null)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Perubahan PIN belum dijalankan ke mesin. HCIS hanya menyimpan rencana sampai pemindahan biometrik terbukti aman.</span>
            </div>

            {plannedByPin.get(correctionTarget.pin) ? (
              <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4">
                <div className="text-xs font-semibold text-sky-900">Rencana aktif</div>
                <div className="mt-1 font-mono text-sm font-bold text-sky-950">
                  {plannedByPin.get(correctionTarget.pin)!.legacyPin} → {plannedByPin.get(correctionTarget.pin)!.intendedPin}
                </div>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() => void cancelCorrection(plannedByPin.get(correctionTarget.pin)!)}
                  className="mt-3 h-9 rounded-xl border border-red-200 bg-white px-3 text-xs font-semibold text-red-700 disabled:opacity-50"
                >
                  Batalkan rencana
                </button>
              </div>
            ) : (
              <>
                <label className="mt-4 block text-xs font-semibold text-muted-foreground">
                  PIN yang seharusnya
                  <input
                    inputMode="numeric"
                    value={intendedPin}
                    onChange={(event) => setIntendedPin(event.target.value.replace(/\D/g, ""))}
                    placeholder="Contoh: 205291318"
                    className="mt-1 h-10 w-full rounded-xl border border-border px-3 font-mono text-sm text-brand-heading outline-none focus:border-brand-primary"
                  />
                </label>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setCorrectionTarget(null)} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold">Batal</button>
                  <button
                    type="button"
                    disabled={busyKey !== null || !intendedPin.trim()}
                    onClick={() => void saveCorrection()}
                    className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Simpan rencana koreksi
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
