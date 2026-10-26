// Koreksi HC: the form holds one work date plus clock times, so the date is entered once. A check-out
// after midnight is marked explicitly ("+1 hari"). The API enforces the same window.

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function correctionTimestamps(input: {
  date: string;
  checkIn: string;
  checkOut: string;
  checkOutNextDay: boolean;
}): { checkInAt: string | null; checkOutAt: string | null; error: string | null } {
  const checkInAt = input.checkIn ? new Date(`${input.date}T${input.checkIn}:00+07:00`).toISOString() : null;
  const checkOutDate = input.checkOutNextDay ? nextDate(input.date) : input.date;
  const checkOutAt = input.checkOut ? new Date(`${checkOutDate}T${input.checkOut}:00+07:00`).toISOString() : null;
  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    return {
      checkInAt, checkOutAt,
      error: input.checkOutNextDay
        ? "Jam pulang harus paling lama 24 jam setelah jam masuk."
        : "Jam pulang lebih awal dari jam masuk. Centang \"Pulang keesokan hari\" untuk shift yang selesai lewat tengah malam.",
    };
  }
  if (checkInAt && checkOutAt && Date.parse(checkOutAt) - Date.parse(checkInAt) > 24 * 60 * 60_000) {
    return { checkInAt, checkOutAt, error: "Jam pulang harus paling lama 24 jam setelah jam masuk." };
  }
  return { checkInAt, checkOutAt, error: null };
}
