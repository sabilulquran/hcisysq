# Mi8VPS host suspend: keep it, or block it? (OPS-MI8-PWR-001)

**Spec ID:** OPS-MI8-PWR-001
**Status:** PLAN, awaiting owner decision. Nothing on production or on the host was changed.
**Prepared:** 2026-10-16 (read-only investigation over `ssh mi8vps-root`)
**Related:** OPS-MI8-KC-001 (`mi8vps-keycloak-readiness-restarts.md`, PR #96, Keycloak restart bursts after suspend),
OPS-MI8-REL-001 (`mi8vps-hcis-release.md`), OPS-MI8-BAK-001 (`mi8vps-sq-core-production-backup-plan.md`)
**Scope:** Android power behaviour of the Mi8VPS phone (MI 8 Lite, Android 10, kernel 4.4.192) that hosts
HCIS, Akun SQ (Keycloak), SQ Hub and Aset SQ in the Ubuntu chroot `/data/local/ubuntu26`. This is a host power
setting. It is not an application change.

## 1. Question

OPS-MI8-KC-001 found that the phone enters kernel suspend. Suspend freezes every chroot process and makes
wall-clock time jump relative to monotonic time. That plan fixes Keycloak and the SQ Core worker so they tolerate
suspend, and leaves this question to the owner: should the host be stopped from suspending at all?

## 2. Evidence (2026-10-16, read-only)

### 2.1 Power state

| Item | Value |
|---|---|
| `/sys/power/wake_lock` | empty (no userspace kernel wakelock held) |
| `/sys/power/autosleep` | `off`; Android `PowerManagerService` drives suspend |
| `dumpsys power` | `mWakefulness=Asleep`, `Wake Locks: size=0`, `mStayOnWhilePluggedInSetting=0`, `mIsPowered=true` (`USB_DCP` charger) |
| `dumpsys deviceidle` | `mDeepEnabled=true`, `mLightEnabled=true`, but `mState=ACTIVE` and `mCharging=true`. Doze does not run while the phone is plugged in |
| `device_idle_constants` | tuned: `inactive_to=900000`, `light_idle_to=900000`, `light_max_idle_to=1800000` (set earlier, origin not recorded) |
| `/sys/power/suspend_stats` | `success: 58870`, `fail: 108420` (mostly `failed_freeze`) since boot on 2026-10-05 |
| Uptime | boot clock about 942,500 s (10.9 days). OPS-MI8-KC-001 measured about 9.1 h spent suspended |
| Load | load average about 4.7; MemAvailable about 1.0 GB |
| Boot scripts | `/data/adb/service.d/mi8vps.sh` starts `boot-worker.sh`. Neither script, nor `start-services.sh` or `condition-termux.sh`, takes a wakelock. `condition-termux.sh` only puts Termux on the Doze whitelist |

### 2.2 Battery and thermal

| Item | Value |
|---|---|
| Battery controller | `battery-controller.sh.disabled` (65–80 % charge window via `input_suspend`) has been off since 2026-10-02. `input_suspend=0` |
| Charge state | `capacity=100`, `status=Full`, `voltage_max=4.4 V`, `cycle_count=27`, `health=Good` |
| Temperature | battery 26.0 °C; `xo_therm`/`quiet_therm` 33 °C; CPU tsens 33.8–36.1 °C; `system_temp_level=0` (no thermal throttling) |
| Gauge | `charge_full` reports 5.58 Ah against a design value of 5.5 Ah. The stock MI 8 Lite battery is 3.35 Ah, so either the pack was replaced or the gauge is wrong (TBD). Percent and charge-counter readings disagree (see §2.4) |

### 2.3 Suspend while plugged in (normal operation)

The kernel log (`PM: suspend entry/exit`, UTC stamps) covers the last 51 minutes, 06:15–07:06 WIB:

- 422 suspend cycles (about 8 per minute), **33.7 s suspended in total = 1.1 %** of the window.
- Longest single suspend 0.80 s; median under 1 ms. Median awake stretch 0.2 s, longest 60 s.
- Wake reasons are RTC alarms, modem/LPASS IPC and Wi-Fi interrupts. Incoming traffic wakes the phone.

While plugged in, the phone is awake about 99 % of the time. The cost is short freezes, under 1 s each. No
service error was traced to these freezes.

### 2.4 Suspend on battery (mains power loss): the real cost

`dumpsys batterystats --history` and the `events` log buffer retain the evening of 15 Oct:

| Time (WIB) | Event |
|---|---|
| 20:22:32, 20:35:50, 20:35:58 | external power drops for 2–6 s at a time, then returns |
| 20:22:38 | `cloudflared-sq-core`: `network is unreachable` within 6 s of the first drop. The Wi-Fi network went down with mains power |
| 20:39:19 | external power lost (`plug=none`, `status=discharging`) |
| 20:43:18 | Doze light idle |
| 20:54:06, 21:09:19 | SQ Core worker stops Keycloak (OPS-MI8-KC-001 burst) |
| 20:59:20 → 21:19:35 | Doze progresses to deep idle (`device_idle=full`) |
| 21:28:25 | power returns (`usbin-plugin`); Doze off; worker stops Keycloak a third time in the same second |
| 21:29–21:31 | tunnel connections register again |

During the 49 minutes on battery, batterystats records **49 min 6 s realtime against 3 min 54 s uptime: the phone
was suspended 92 % of the time**, waking about every 5 minutes (fuel-gauge `msoc-delta` interrupt) and every
10 minutes (RTC alarm). Battery went from 100 % to 92 % while the charge counter fell only 23 mAh, so the percent
reading after a long float at 100 % is not reliable.

The two other Keycloak bursts match tunnel-unreachable windows in `cloudflared-sq-core.log` as well:

| Keycloak restarts (WIB) | Tunnel `network is unreachable` (WIB) |
|---|---|
| 9 Oct 13:44–15:48 (6 restarts) | 9 Oct 13:09–15:50 |
| 14 Oct 21:31–22:31 (5 restarts) | 14 Oct 21:22–22:33 |
| 15 Oct 20:54–21:28 (3 restarts) | 15 Oct 20:22–21:31 (power loss proven above) |

Battery history from 9 and 14 Oct is no longer retained, so those two are consistent with a power cut but not
proven. Rough budget for the 9.1 h: plugged-in suspend at about 1 % over 10.9 days gives about 2.9 h. The three
outages above (about 5 h at about 92 %) give about 4.6 h. Shorter tunnel drops on 6, 11, 12 and 13 Oct may
account for the rest (estimate).

### 2.5 What this means

1. The long suspends, the wall-clock jumps and the Keycloak bursts happen **during mains power cuts**.
2. During those cuts the local network is down too: `network is unreachable` starts within seconds of the power
   drop and ends when power returns. Users cannot reach the services then, whether the phone sleeps or not.
3. While plugged in, suspend costs about 1 % of time in sub-second slices. That is not a meaningful user cost.
4. Suspending on battery is useful: it stretches the battery through an outage, and services resume where they
   left off instead of cold-booting after the battery runs out. Keycloak is the exception, and OPS-MI8-KC-001
   already fixes it.

## 3. Options

| | Option | Plugged in | On battery (power cut) | Battery / thermal | Persists after reboot | Verdict |
|---|---|---|---|---|---|---|
| **0** | **Keep suspend as is**; rely on OPS-MI8-KC-001 A + B | ~1 % sub-second freezes | ~92 % suspended; services freeze and resume | unchanged | n/a | **Recommended** |
| W1 | Kernel wakelock held always from a boot script (`echo mi8vps-sq-core > /sys/power/wake_lock` in `/data/adb/service.d/`) | 0 % suspended | 0 % suspended; full drain while the network is down anyway | Plugged: negligible (already awake 99 %). On battery: awake drain, not measured. Estimate several times the 92 %-suspended rate. A long cut can empty the battery, hard power-off, then a cold boot of the whole stack and PostgreSQL crash recovery when power returns | yes, through the boot script | Not recommended now |
| W2 | W1 with a floor: a loop holds the lock while plugged **or** capacity ≥ 50 %, and releases it below 50 % on battery | 0 % | awake until 50 %, then suspends | as W1, bounded at half the battery | yes | Only worth it if the router/ONT gets a UPS (§6) |
| D | `dumpsys deviceidle disable` | no effect: Doze never runs while charging | Doze off, but the kernel still suspends whenever no wakelock is held. Chroot processes are not Android apps, so Doze does not throttle them anyway | none | believed not to persist through a reboot (TBD) | Rejected: no effect on the problem |
| S | Stay awake while plugged (`settings put global stay_on_while_plugged_in 3`) | 0 %, but holds a **screen-on** wakelock: backlight on 24/7 | no effect: releases when unplugged | backlight power and heat, panel wear; an always-on unlocked screen is a physical-access risk | yes (global setting) | Rejected |

A kernel wakelock in `/sys/power/wake_lock` (`radio:wakelock 0660`, root can write) blocks system suspend only.
CPU idle states and frequency scaling still work, so an idle CPU still saves power. The lock stays until
`echo <name> > /sys/power/wake_unlock` or a reboot. A timed variant (`echo "<name> <ns>" > /sys/power/wake_lock`)
releases itself, which makes it suitable for the trial in G1.

## 4. Recommendation

**Option 0.** Keep host suspend and land OPS-MI8-KC-001 A (Keycloak `cache=local`) and B (worker counts awake
probes). After that, a resume no longer triggers restarts. A wakelock would only keep the phone awake during
power cuts, when the network is down and nobody can use the services. It would also spend the battery that
lets the phone ride through the cut without a cold boot.

Revisit W2 only if the network side stays up during power cuts (router/ONT on a UPS). Then staying awake on
battery would keep the services online, and the 50 % floor caps the risk.

## 5. Owner approval gates

Each gate needs its own explicit approval. Nothing below runs without one.

| Gate | Decision | Host change | Needed for option 0? |
|---|---|---|---|
| **G0** | Accept option 0: keep host suspend, rely on OPS-MI8-KC-001 A + B | none | yes (decision only) |
| G1 | Optional 30-minute measurement with a **timed** wakelock while plugged in, to record temperature and current with suspend blocked | transient, self-expiring | no |
| G2 | Install W1 or W2 as a boot script | persistent | no; only if the owner rejects option 0 |
| G3 | On-battery drain test for W2 (unplug with the owner present, stop at 80 %) | transient | only before G2 with W2 |

### G1 measurement (if approved)

1. Record the baseline: `suspend_stats` success count; `/proc/uptime` (boot clock) and the monotonic `now at`
   from `/proc/timer_list`; battery `temp`, `current_now`, `status`; max CPU tsens; load average.
2. `echo "mi8vps-pwr-trial 1800000000000" > /sys/power/wake_lock` (30 min, releases itself).
3. At 25 minutes, record the same values.
4. **Pass:** `suspend_stats` success did not increase; (boot − monotonic) did not grow; battery temp rose
   ≤ 3 °C; `status` stayed `Full` or `Charging`; services stayed ready (`sq-corectl.sh status`).
5. After 30 minutes, `/sys/power/wake_lock` is empty again.

### G2 install and test (only if option 0 is rejected)

1. Write `/data/adb/service.d/40-mi8vps-wakelock.sh` (root, mode 0700). W1: `echo mi8vps-sq-core > /sys/power/wake_lock`.
   W2: a loop every 60 s that locks while `usb/online=1` or `capacity >= 50` and unlocks otherwise, logging
   each change to `/data/local/mi8vps/wakelock.log`.
2. Run it once by hand (no reboot needed). Check that `/sys/power/wake_lock` lists `mi8vps-sq-core`.
3. **Pass after 24 h:** `suspend_stats` success is unchanged; (boot − monotonic) did not grow; battery temp
   stayed ≤ 35 °C and CPU tsens did not rise by more than 3 °C over the G1 baseline; no new worker `stop` lines.
4. Confirm it after the next planned reboot (the lock is present after `boot_completed`).

## 6. Rollback

- **G1:** none needed; the lock expires. To end it early: `echo mi8vps-pwr-trial > /sys/power/wake_unlock`.
- **G2:** `mv /data/adb/service.d/40-mi8vps-wakelock.sh /data/adb/service.d/40-mi8vps-wakelock.sh.disabled`,
  stop the W2 loop if it runs, then `echo mi8vps-sq-core > /sys/power/wake_unlock`. Check that `/sys/power/wake_lock`
  is empty. No reboot and no service restart.
- Option D or S, if tried anyway: `dumpsys deviceidle enable`; `settings put global stay_on_while_plugged_in 0`.

## 7. User-facing impact

- **Option 0:** none beyond OPS-MI8-KC-001.
- **G1 and G2:** no outage and no service restart. With W1 or W2, a long power cut can empty the battery. The
  services then cold-boot when power returns, which takes several minutes, instead of resuming instantly.

## 8. Open questions for the owner

1. Is the router/ONT on a UPS or on the same mains circuit as the phone charger? The evidence says it goes down
   with the power. This decides whether W2 has any value.
2. How often and how long are the local power cuts? Three in seven days, of 1–3 h, are visible in the logs.
3. Battery health, out of scope here: the 65–80 % battery controller is disabled, so the phone floats at
   100 %/4.4 V all the time. At 26 °C this is acceptable short term, but it ages the pack faster. Re-enabling a
   charge window is a separate decision. Note that a lower charge window also shortens how long suspend can ride
   through a cut.

## 9. Audit and evidence

Record the decision (who, when, which gate) in the Mi8VPS Platform Runbook or a dated note next to this file.
Evidence quotes counters, temperatures and log categories only. It holds no user identifiers, IP addresses,
tunnel or connection IDs, or secrets.
