import sqWordmarkGold from "@/assets/brand/sq-wordmark-gold.png";
import ysqMark from "@/assets/brand/ysq-mark.png";

interface BrandLockupProps {
  compact?: boolean;
}

/**
 * App lockup from the SQ Core design system: the eight-point star, the app
 * name in heavy sans, and the gold "SABILUL QUR'AN" wordmark cut from the
 * official foundation logo (sabilulquran/SQ-Hub docs/design/sq-core-design-system-c.md).
 */
export function BrandLockup({ compact = false }: BrandLockupProps) {
  return (
    <div
      className={compact ? "flex min-w-0 items-center gap-2" : "flex min-w-0 items-center gap-2.5"}
      aria-label="HCIS · Yayasan Sabilul Qur'an"
    >
      <img
        src={ysqMark}
        alt=""
        className={compact ? "h-9 w-9 shrink-0 object-contain" : "h-11 w-11 shrink-0 object-contain"}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p
          className={
            compact
              ? "truncate text-sm font-extrabold leading-none tracking-[-0.01em] text-brand-heading"
              : "text-base font-extrabold leading-none tracking-[-0.01em] text-brand-heading"
          }
        >
          HCIS
        </p>
        <img
          src={sqWordmarkGold}
          alt="Yayasan Sabilul Qur'an"
          className={compact ? "h-3.5 w-auto max-w-none" : "h-4 w-auto max-w-none"}
        />
      </div>
    </div>
  );
}
