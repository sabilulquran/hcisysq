// EMP-003 P2-4, employee side (spec §7.3): propose a change to your own data
// and see where each proposal stands. Nothing here decides anything — HC does
// that — and nothing here edits the employee master directly.

import { useEffect, useState, type FormEvent } from "react";

import { MyDataChanges } from "@/components/employment/DataChangePanels";
import { AppShell } from "@/layouts/AppShell";
import { EmploymentApiError, type EmploymentView } from "@/lib/employment";
import {
  TARGET_LABEL,
  cancelMyDataChange,
  getMyDataChanges,
  submitDataChange,
  type DataChangeRequest,
  type DataChangeTarget,
} from "@/lib/employeeDataChanges";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";

const field = "w-full rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm";
const primaryButton = "rounded-xl bg-brand-primary-deep px-4 py-2 text-sm font-bold text-white disabled:opacity-60";
const quietButton = "rounded-xl border border-border/70 px-3 py-1.5 text-xs font-bold text-muted-foreground";

/**
 * Only the two sections an employee can describe in a short form. Family,
 * education and skills are proposed from their own screens once those exist
 * for employees; until then HC records them (spec §7.3).
 */
const OPEN_TARGETS: DataChangeTarget[] = ["ALAMAT", "KONTAK"];

interface AddressDraft {
  kind: "DOMISILI" | "KTP";
  addressLine: string;
  village: string;
  district: string;
  city: string;
  province: string;
  postalCode: string;
  validFrom: string;
}

const EMPTY_ADDRESS: AddressDraft = {
  kind: "DOMISILI",
  addressLine: "",
  village: "",
  district: "",
  city: "",
  province: "",
  postalCode: "",
  validFrom: "",
};

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function viewFromDataChangeError(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Usulan perubahan data tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

export function EmployeeDataChangesPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [view, setView] = useState<EmploymentView<DataChangeRequest[]>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [target, setTarget] = useState<DataChangeTarget | null>(null);
  const [address, setAddress] = useState<AddressDraft>({ ...EMPTY_ADDRESS });
  const [contact, setContact] = useState({ email: "", phone: "", clearEmail: false, clearPhone: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getEmployeeLeaveSummary()
      .then((summary) => { if (mounted) setEmployee(summary.employee); })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    setView({ kind: "loading" });
    void getMyDataChanges()
      .then((data) => { if (mounted) setView({ kind: "ready", data: data.rows }); })
      .catch((cause: unknown) => { if (mounted) setView(viewFromDataChangeError(cause)); });
    return () => { mounted = false; };
  }, [reloadToken]);

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof EmploymentApiError ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    const payload: Record<string, unknown> = target === "ALAMAT"
      ? {
        kind: address.kind,
        addressLine: address.addressLine.trim(),
        village: blankToNull(address.village),
        district: blankToNull(address.district),
        city: address.city.trim(),
        province: blankToNull(address.province),
        postalCode: blankToNull(address.postalCode),
        validFrom: address.validFrom,
      }
      // Only the fields the employee actually filled, or explicitly asked to
      // clear. A blank box is "leave this alone": sending it as null made
      // accepting the proposal delete a contact detail nobody had touched.
      : {
        ...(contact.clearEmail ? { email: null } : contact.email.trim() ? { email: contact.email.trim() } : {}),
        ...(contact.clearPhone ? { phone: null } : contact.phone.trim() ? { phone: contact.phone.trim() } : {}),
      };
    void run(async () => {
      await submitDataChange(target, payload);
      setNotice("Usulan terkirim dan menunggu keputusan Human Capital.");
      setTarget(null);
      setAddress({ ...EMPTY_ADDRESS });
      setContact({ email: "", phone: "", clearEmail: false, clearPhone: false });
      setReloadToken((token) => token + 1);
    }, "Usulan tidak dapat dikirim.");
  };

  return (
    <AppShell user={employeeShellUser(employee)} activeItem="Data Saya">
      <div className="grid gap-5">
        <header>
          <h1 className="text-xl font-bold text-brand-heading">Data saya</h1>
          <p className="text-sm text-muted-foreground">
            Ajukan perubahan atas data Anda sendiri. Human Capital yang memutuskan, dan Anda melihat hasilnya di sini.
          </p>
        </header>

        {notice ? <p role="status" className="rounded-2xl border border-border/70 bg-surface p-4 text-sm">{notice}</p> : null}
        {error ? <p role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          {OPEN_TARGETS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === target ? primaryButton : quietButton}
              onClick={() => setTarget(option)}
            >
              Ajukan perubahan {TARGET_LABEL[option].toLowerCase()}
            </button>
          ))}
          {target ? (
            <button type="button" className={quietButton} onClick={() => setTarget(null)}>Batal</button>
          ) : null}
        </div>

        {target === "ALAMAT" ? (
          <form onSubmit={submit} className="grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-bold text-brand-heading">Usulan alamat</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Jenis</span>
              <select className={field} value={address.kind} onChange={(event) => setAddress({ ...address, kind: event.target.value as AddressDraft["kind"] })}>
                <option value="DOMISILI">Domisili</option>
                <option value="KTP">Sesuai KTP</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Berlaku sejak</span>
              <input className={field} type="date" required value={address.validFrom} onChange={(event) => setAddress({ ...address, validFrom: event.target.value })} />
            </label>
            <label className="sm:col-span-2 block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Alamat</span>
              <textarea className={field} rows={2} required value={address.addressLine} onChange={(event) => setAddress({ ...address, addressLine: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Desa/kelurahan</span>
              <input className={field} value={address.village} onChange={(event) => setAddress({ ...address, village: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Kecamatan</span>
              <input className={field} value={address.district} onChange={(event) => setAddress({ ...address, district: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Kota/kabupaten</span>
              <input className={field} required value={address.city} onChange={(event) => setAddress({ ...address, city: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Provinsi</span>
              <input className={field} value={address.province} onChange={(event) => setAddress({ ...address, province: event.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-bold text-brand-heading">Kode pos</span>
              <input className={field} inputMode="numeric" value={address.postalCode} onChange={(event) => setAddress({ ...address, postalCode: event.target.value })} />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className={primaryButton} disabled={busy}>Kirim usulan</button>
            </div>
          </form>
        ) : null}

        {target === "KONTAK" ? (
          <form onSubmit={submit} className="grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-bold text-brand-heading">Usulan kontak</h2>
            <div className="block text-sm">
              <label>
                <span className="mb-1 block font-bold text-brand-heading">Email baru</span>
                <input
                  className={field}
                  type="email"
                  disabled={contact.clearEmail}
                  value={contact.email}
                  onChange={(event) => setContact({ ...contact, email: event.target.value })}
                />
              </label>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={contact.clearEmail}
                  onChange={(event) => setContact({ ...contact, clearEmail: event.target.checked })}
                />
                Usulkan agar email dihapus
              </label>
            </div>
            <div className="block text-sm">
              <label>
                <span className="mb-1 block font-bold text-brand-heading">Telepon baru</span>
                <input
                  className={field}
                  disabled={contact.clearPhone}
                  value={contact.phone}
                  onChange={(event) => setContact({ ...contact, phone: event.target.value })}
                />
              </label>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={contact.clearPhone}
                  onChange={(event) => setContact({ ...contact, clearPhone: event.target.checked })}
                />
                Usulkan agar nomor telepon dihapus
              </label>
            </div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              Kotak yang dibiarkan kosong tidak diubah. Untuk menghapus sebuah data, centang pilihan di bawahnya.
            </p>
            <div className="sm:col-span-2">
              <button type="submit" className={primaryButton} disabled={busy}>Kirim usulan</button>
            </div>
          </form>
        ) : null}

        <MyDataChanges
          view={view}
          busy={busy}
          onCancel={(requestId) => void run(async () => {
            await cancelMyDataChange(requestId);
            setNotice("Usulan dibatalkan.");
            setReloadToken((token) => token + 1);
          }, "Usulan tidak dapat dibatalkan.")}
        />
      </div>
    </AppShell>
  );
}
