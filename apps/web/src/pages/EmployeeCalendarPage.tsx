// CAL-001 employee surface: the foundation-wide month calendar (K-05), "Rapat saya" upcoming and
// past, the invitation form and the meeting detail. Spec: docs/domain/meeting-calendar.md §12.
// Phones get a list per day instead of the narrow month grid.

import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Lock, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { MeetingDetailPanel } from "@/components/meetings/MeetingDetailPanel";
import { MeetingForm } from "@/components/meetings/MeetingForm";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  calendarItemLabel,
  cancelMeeting,
  formatDateLong,
  formatMeetingRange,
  formatMonth,
  getMeeting,
  getMyCalendar,
  getMyMeetings,
  itemsByDate,
  jakartaDate,
  jakartaTime,
  MeetingApiError,
  monthGrid,
  RESPONSE_LABELS,
  respondToMeeting,
  shiftMonth,
  type CalendarItem,
  type MeetingDetail,
  type MeetingSummary,
  type Pagination,
} from "@/lib/meetings";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function chipClass(item: CalendarItem) {
  switch (item.kind) {
    case "meeting":
      if (item.status === "CANCELLED") return "bg-muted text-muted-foreground line-through";
      return item.involvesMe ? "bg-brand-primary text-brand-foreground" : "bg-cat-task-soft text-cat-task";
    case "busy": return "bg-muted text-muted-foreground";
    case "leave": return "bg-cat-leave-soft text-cat-leave";
    case "trip": return "bg-cat-service-soft text-cat-service";
    case "non_working": return "bg-danger-soft text-danger-ink";
    case "critical_period": return "bg-warning-soft text-warning-ink";
  }
}

function problemMessage(cause: unknown, fallback: string) {
  if (cause instanceof MeetingApiError) {
    if (cause.code === "MEETING_NOT_FOUND") return "Rapat tidak ditemukan, atau Anda bukan peserta rapat ini.";
    if (cause.code === "MEETING_CONFLICT" && cause.conflicts.length > 0) return cause.conflicts.map((issue) => issue.message).join(" ");
    return cause.message;
  }
  return cause instanceof Error ? cause.message : fallback;
}

function ItemRow({ item, onOpen }: { item: CalendarItem; onOpen: (id: string) => void }) {
  const openable = item.kind === "meeting" && item.id;
  const body = (
    <>
      <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", chipClass(item))} aria-hidden="true" />
      <span className="min-w-0">
        {item.kind === "meeting" ? (
          <>
            <span className={cn("block font-semibold text-brand-heading", item.status === "CANCELLED" && "line-through")}>
              {item.title}{item.status === "CANCELLED" ? " (dibatalkan)" : ""}
            </span>
            <span className="block text-xs text-muted-foreground">
              {jakartaTime(item.startAt)}–{jakartaTime(item.endAt)}
              {item.location ? ` · ${item.location}` : ""} · {item.organizerName}
              {item.myResponse && item.myRole === "ATTENDEE" ? ` · ${RESPONSE_LABELS[item.myResponse]}` : ""}
            </span>
          </>
        ) : item.kind === "busy" ? (
          <>
            <span className="flex items-center gap-1 font-semibold text-muted-foreground"><Lock className="h-3 w-3" aria-hidden="true" />Sibuk</span>
            <span className="block text-xs text-muted-foreground">{jakartaTime(item.startAt)}–{jakartaTime(item.endAt)} · rapat rahasia</span>
          </>
        ) : (
          <span className="block font-semibold text-brand-heading">{calendarItemLabel(item)}</span>
        )}
      </span>
    </>
  );
  return openable ? (
    <button type="button" onClick={() => onOpen(item.id!)} className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted/60">
      {body}
    </button>
  ) : (
    <div className="flex items-start gap-2 px-2 py-2 text-sm">{body}</div>
  );
}

export function EmployeeCalendarPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [tab, setTab] = useState<"calendar" | "list">("calendar");
  const [month, setMonth] = useState(() => jakartaDate().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(() => jakartaDate());
  const [items, setItems] = useState<CalendarItem[]>([]);
  // K-16: unknown counts as not active, so the screen never promises a WhatsApp that is not sent.
  const [whatsappActive, setWhatsappActive] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [listTab, setListTab] = useState<"upcoming" | "past">("upcoming");
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState<MeetingDetail | null>(null);
  const [form, setForm] = useState<{ date: string; editing: MeetingDetail | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const grid = useMemo(() => monthGrid(month), [month]);
  const byDate = useMemo(() => itemsByDate(items), [items]);
  const today = jakartaDate();

  const loadCalendar = useCallback(async () => {
    setCalendarLoading(true);
    try {
      const result = await getMyCalendar(grid[0]!.date, grid[grid.length - 1]!.date);
      setItems(result.items);
      setWhatsappActive(result.whatsappDelivery === "active");
    } catch (cause) {
      setError(problemMessage(cause, "Kalender tidak dapat dimuat."));
    } finally {
      setCalendarLoading(false);
    }
  }, [grid]);

  const loadList = useCallback(async (which: "upcoming" | "past", page: number) => {
    setListLoading(true);
    try {
      const result = await getMyMeetings(which, page);
      setMeetings(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      setError(problemMessage(cause, "Daftar rapat tidak dapat dimuat."));
    } finally {
      setListLoading(false);
    }
  }, []);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      setSelected(await getMeeting(id));
      setForm(null);
    } catch (cause) {
      setSelected(null);
      setError(problemMessage(cause, "Rapat tidak dapat dibuka."));
    }
  }, []);

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    // A notification links here with ?meeting=<id>.
    const linked = new URLSearchParams(window.location.search).get("meeting");
    if (linked) void open(linked);
  }, [open]);

  useEffect(() => { void loadCalendar(); }, [loadCalendar]);
  // Phones stack the panel under the calendar: bring the form or detail into view.
  useEffect(() => {
    if ((form || selected) && window.innerWidth < 1024) {
      document.getElementById("meeting-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [form, selected]);
  useEffect(() => { void loadList(listTab, 1); }, [listTab, loadList]);

  const refresh = async (id?: string) => {
    await Promise.all([loadCalendar(), loadList(listTab, paging?.page ?? 1), id ? open(id) : Promise.resolve()]);
  };

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(problemMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  const respond = (meeting: MeetingDetail, response: "ACCEPTED" | "DECLINED") => {
    let note: string | null = null;
    if (response === "DECLINED") {
      const answer = window.prompt("Alasan berhalangan (boleh dikosongkan)");
      if (answer === null) return;
      note = answer.trim() || null;
    }
    void run(async () => {
      await respondToMeeting(meeting.id, response, note);
      setNotice(response === "ACCEPTED" ? "Kehadiran Anda tercatat." : "Penyelenggara diberi tahu bahwa Anda berhalangan.");
      await refresh(meeting.id);
    }, "Jawaban tidak dapat disimpan.");
  };

  const cancel = (meeting: MeetingDetail) => {
    const reason = window.prompt("Alasan pembatalan (5–500 karakter). Semua peserta akan diberi tahu.");
    if (!reason || reason.trim().length < 5) return;
    void run(async () => {
      await cancelMeeting(meeting.id, reason.trim());
      setNotice("Rapat dibatalkan. Waktu peserta kembali kosong.");
      await refresh(meeting.id);
    }, "Rapat tidak dapat dibatalkan.");
  };

  const startCreate = (date: string) => {
    setSelected(null);
    setNotice(null);
    setForm({ date: date < today ? today : date, editing: null });
  };

  const selectedItems = byDate.get(selectedDate) ?? [];
  // Phones: every day of the month that has something, plus the selected day.
  const mobileDays = grid.filter((cell) => cell.inMonth
    && (cell.date === selectedDate || (byDate.get(cell.date) ?? []).some((item) => item.kind !== "non_working")));

  return (
    <AppShell user={user} activeItem="Kalender">
      <section className="mx-auto max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Layanan Pegawai</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-brand-heading sm:text-3xl">Kalender &amp; Rapat</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Rapat yayasan, cuti, dan perjalanan dinas Anda dalam satu kalender. Undangan ditolak bila jadwal peserta bentrok
              dengan rapat lain, cuti, atau dinas yang sudah disetujui.
            </p>
          </div>
          <button type="button" onClick={() => startCreate(selectedDate)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground">
            <Plus className="h-4 w-4" aria-hidden="true" />Buat rapat
          </button>
        </div>

        {error ? <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice ? <div role="status" className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <div className="mt-6 inline-flex rounded-xl border border-border bg-surface p-1" role="tablist" aria-label="Tampilan">
          {([["calendar", "Kalender"], ["list", "Rapat saya"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={cn("min-h-10 rounded-lg px-4 text-sm font-bold", tab === key ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground")}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            {tab === "calendar" ? (
              <section className="rounded-3xl border border-border/75 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
                <div className="flex items-center justify-between gap-2">
                  <button type="button" aria-label="Bulan sebelumnya" onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg p-2 hover:bg-muted">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <h2 className="flex items-center gap-2 text-base font-bold capitalize text-brand-heading">
                    {formatMonth(month)}
                    {calendarLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Memuat" /> : null}
                  </h2>
                  <button type="button" aria-label="Bulan berikutnya" onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg p-2 hover:bg-muted">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 hidden sm:block">
                  <div className="grid grid-cols-7 text-center text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    {WEEKDAYS.map((day) => <div key={day} className="py-1">{day}</div>)}
                  </div>
                  <div className="grid grid-cols-7 gap-px overflow-hidden rounded-2xl border border-border/70 bg-border/70">
                    {grid.map((cell) => {
                      const dayItems = byDate.get(cell.date) ?? [];
                      const holiday = dayItems.find((item) => item.kind === "non_working");
                      const visible = dayItems.filter((item) => item.kind !== "non_working");
                      return (
                        <button key={cell.date} type="button" onClick={() => setSelectedDate(cell.date)}
                          aria-label={formatDateLong(cell.date)} aria-pressed={cell.date === selectedDate}
                          className={cn(
                            "flex min-h-24 flex-col gap-1 bg-surface p-1.5 text-left align-top hover:bg-muted/50",
                            !cell.inMonth && "bg-surface/60 text-muted-foreground/60",
                            cell.date === selectedDate && "ring-2 ring-inset ring-brand-primary",
                          )}>
                          <span className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                            cell.date === today ? "bg-brand-primary text-brand-foreground" : holiday ? "text-danger-ink" : "text-brand-heading",
                          )}>
                            {Number(cell.date.slice(8))}
                          </span>
                          {holiday ? <span className="truncate text-[10px] text-danger-ink">{calendarItemLabel(holiday)}</span> : null}
                          {visible.slice(0, 3).map((item, index) => (
                            <span key={index} className={cn("truncate rounded px-1 text-[10px] font-semibold", chipClass(item))}>
                              {calendarItemLabel(item)}
                            </span>
                          ))}
                          {visible.length > 3 ? <span className="text-[10px] text-muted-foreground">+{visible.length - 3} lainnya</span> : null}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 rounded-2xl border border-border/70 bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-brand-heading">{formatDateLong(selectedDate)}</h3>
                      {selectedDate >= today ? (
                        <button type="button" onClick={() => startCreate(selectedDate)} className="text-sm font-bold text-brand-primary-deep hover:underline">
                          + Rapat di tanggal ini
                        </button>
                      ) : null}
                    </div>
                    {selectedItems.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">Belum ada rapat.</p>
                    ) : (
                      <div className="mt-1">{selectedItems.map((item, index) => <ItemRow key={index} item={item} onOpen={(id) => void open(id)} />)}</div>
                    )}
                  </div>
                </div>

                <div className="mt-3 space-y-3 sm:hidden">
                  {calendarLoading && items.length === 0 ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</p>
                  ) : mobileDays.length === 0 ? (
                    <p className="py-6 text-sm text-muted-foreground">Belum ada rapat bulan ini.</p>
                  ) : mobileDays.map((cell) => {
                    const dayItems = byDate.get(cell.date) ?? [];
                    return (
                      <div key={cell.date} className="rounded-2xl border border-border/70 bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className={cn("text-sm font-bold", cell.date === today ? "text-brand-primary-deep" : "text-brand-heading")}>{formatDateLong(cell.date)}</h3>
                          {cell.date >= today ? (
                            <button type="button" aria-label={`Buat rapat ${formatDateLong(cell.date)}`} onClick={() => startCreate(cell.date)}
                              className="rounded-lg p-2 text-brand-primary-deep hover:bg-muted"><Plus className="h-4 w-4" /></button>
                          ) : null}
                        </div>
                        {dayItems.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada rapat.</p>
                          : dayItems.map((item, index) => <ItemRow key={index} item={item} onOpen={(id) => void open(id)} />)}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : (
              <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
                <div className="flex gap-2 px-5 pt-5">
                  {([["upcoming", "Akan datang"], ["past", "Lewat"]] as const).map(([key, label]) => (
                    <button key={key} type="button" aria-pressed={listTab === key} onClick={() => setListTab(key)}
                      className={cn("min-h-10 rounded-lg px-3 text-sm font-bold", listTab === key ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground hover:bg-muted")}>
                      {label}
                    </button>
                  ))}
                </div>
                {listLoading ? (
                  <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
                ) : meetings.length === 0 ? (
                  <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada rapat.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border/70">
                    {meetings.map((meeting) => (
                      <li key={meeting.id}>
                        <button type="button" onClick={() => void open(meeting.id)}
                          className={cn("flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50", selected?.id === meeting.id && "bg-muted/60")}>
                          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                          <span className="min-w-0">
                            <span className={cn("block truncate font-semibold text-brand-heading", meeting.status === "CANCELLED" && "line-through")}>
                              {meeting.title}
                            </span>
                            <span className="block text-xs text-muted-foreground">{formatMeetingRange(meeting.startAt, meeting.endAt)}</span>
                            <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                              {meeting.status === "CANCELLED" ? "Dibatalkan" : meeting.myRole === "ORGANIZER" ? "Anda penyelenggara" : RESPONSE_LABELS[meeting.myResponse]}
                              {` · ${meeting.participantCount} orang`}
                              {meeting.confidential ? " · Rahasia" : ""}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {paging && paging.total > 0 ? (
                  <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total}
                    onPageChange={(page) => void loadList(listTab, page)} />
                ) : null}
              </section>
            )}
          </div>

          <aside id="meeting-panel" className="min-w-0 scroll-mt-4">
            {form ? (
              <MeetingForm
                key={form.editing ? `edit-${form.editing.id}-${form.editing.version}` : `new-${form.date}`}
                defaultDate={form.date}
                editing={form.editing}
                whatsappActive={whatsappActive}
                onClose={() => setForm(null)}
                onSaved={(id, message) => {
                  setForm(null);
                  setNotice(message);
                  void refresh(id);
                }}
              />
            ) : selected ? (
              <MeetingDetailPanel
                meeting={selected}
                busy={busy}
                whatsappActive={whatsappActive}
                onClose={() => setSelected(null)}
                onRespond={(response) => respond(selected, response)}
                onEdit={() => setForm({ date: jakartaDate(selected.startAt), editing: selected })}
                onCancel={() => cancel(selected)}
              />
            ) : (
              <div className="rounded-3xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                Pilih rapat untuk melihat peserta dan menjawab undangan, atau tekan <span className="font-semibold">Buat rapat</span>.
                Rapat orang lain hanya tampil ringkas; rapat rahasia tampil sebagai "Sibuk".
              </div>
            )}
          </aside>
        </div>
      </section>
    </AppShell>
  );
}
