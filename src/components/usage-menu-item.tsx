import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { GeminiAccountUsage, GeminiQuotaModelUsage } from "@/types";

type UsageMenuItemProps = {
  usage: GeminiAccountUsage | null;
  loading: boolean;
  error: string | null;
};

const numberFormatter = new Intl.NumberFormat();
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const HOVER_CARD_CLOSE_DELAY_MS = 700;

function formatCount(value: number) {
  return numberFormatter.format(value);
}

function usageSummary(
  usage: GeminiAccountUsage | null,
  loading: boolean,
  error: string | null,
) {
  if (loading && !usage) {
    return "Loading…";
  }
  if (error || !usage) {
    return "Unavailable";
  }
  if (usage.quota.usedPercent !== undefined) {
    return `${100 - usage.quota.usedPercent}% left`;
  }
  if (usage.quota.models.length > 0) {
    const remaining = Math.min(
      ...usage.quota.models.map((model) => model.remainingPercent),
    );
    return `${remaining}% left`;
  }
  return `${compactNumberFormatter.format(usage.tokens.total)} tokens`;
}

function UsageBar({ value }: { value: number }) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div
      className="h-1 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={`${safeValue}% used`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={safeValue}
    >
      <div
        className={cn(
          "h-full rounded-full",
          safeValue >= 90
            ? "bg-destructive"
            : safeValue >= 75
              ? "bg-amber-500"
              : "bg-primary",
        )}
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}

function ModelQuotaRow({ model }: { model: GeminiQuotaModelUsage }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className="font-medium">{model.name}</span>
        <span className="tabular-nums text-muted-foreground">
          {model.remainingPercent}% available
        </span>
      </div>
      <UsageBar value={model.usedPercent} />
      <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{model.usedPercent}% used</span>
        {model.resetLabel ? <span>Resets {model.resetLabel}</span> : null}
      </div>
    </div>
  );
}

function UsageLoadingState() {
  return (
    <div className="grid gap-3 py-1">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-12" />
      <Skeleton className="h-16" />
    </div>
  );
}

function UsageDetails({ usage }: { usage: GeminiAccountUsage }) {
  const quota = usage.quota;
  const hasExactQuota =
    quota.limit !== undefined &&
    quota.used !== undefined &&
    quota.remaining !== undefined;

  return (
    <div className="grid gap-3">
      <section className="grid gap-2.5" aria-labelledby="daily-quota-title">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 id="daily-quota-title" className="text-xs font-medium">
              Daily request quota
            </h3>
            {quota.tier ? (
              <p className="mt-0.5 max-w-44 truncate text-[11px] text-muted-foreground">
                {quota.tier}
              </p>
            ) : null}
          </div>
          {quota.limit !== undefined ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatCount(quota.limit)} / day
            </span>
          ) : null}
        </div>

        {hasExactQuota ? (
          <div className="grid gap-1.5">
            <div className="flex justify-between gap-3 text-xs">
              <span>{formatCount(quota.used ?? 0)} used</span>
              <span className="tabular-nums text-muted-foreground">
                {formatCount(quota.remaining ?? 0)} available
              </span>
            </div>
            <UsageBar value={quota.usedPercent ?? 0} />
            {quota.resetLabel ? (
              <p className="text-right text-[11px] text-muted-foreground">
                Resets {quota.resetLabel}
              </p>
            ) : null}
          </div>
        ) : null}

        {quota.models.map((model) => (
          <ModelQuotaRow key={model.name} model={model} />
        ))}

        {usage.quotaError ? (
          <p className="rounded-md bg-muted/55 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            {usage.quotaError}
          </p>
        ) : null}
      </section>

      <section className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs">
        <span className="font-medium">Tokens today</span>
        <span className="font-medium tabular-nums">
          {formatCount(usage.tokens.total)}
        </span>
        <span className="text-muted-foreground">Input / output</span>
        <span className="tabular-nums text-muted-foreground">
          {formatCount(usage.tokens.input)} / {formatCount(usage.tokens.output)}
        </span>
        <span className="text-muted-foreground">Sessions / model calls</span>
        <span className="tabular-nums text-muted-foreground">
          {usage.tokens.sessions} / {usage.tokens.modelCalls}
        </span>
      </section>

      <p className="border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
        Tokens are from local Gemini CLI sessions today. Request quota spans the
        account, including usage outside Conductor.
      </p>
    </div>
  );
}

export function UsageMenuItem({ usage, loading, error }: UsageMenuItemProps) {
  const [hoverCardOpen, setHoverCardOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setHoverCardOpen(false);
      closeTimerRef.current = null;
    }, HOVER_CARD_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return (
    <HoverCard
      open={hoverCardOpen}
      onOpenChange={(open, eventDetails) => {
        if (open) {
          clearCloseTimer();
          setHoverCardOpen(true);
          return;
        }

        if (
          eventDetails.reason === "trigger-hover" ||
          eventDetails.reason === "trigger-focus"
        ) {
          eventDetails.cancel();
          scheduleClose();
          return;
        }

        clearCloseTimer();
        setHoverCardOpen(false);
      }}
    >
      <HoverCardTrigger
        delay={250}
        closeDelay={HOVER_CARD_CLOSE_DELAY_MS}
        onMouseEnter={clearCloseTimer}
        onMouseLeave={scheduleClose}
        render={<DropdownMenuItem closeOnClick={false} />}
      >
        <span>Usage</span>
        <span className="min-w-0 flex-1 text-right text-xs tabular-nums text-muted-foreground">
          {usageSummary(usage, loading, error)}
        </span>
        <ChevronRight aria-hidden="true" />
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        sideOffset={8}
        className="w-80 p-3"
        onMouseEnter={clearCloseTimer}
        onMouseLeave={scheduleClose}
      >
        <div>
          <p className="text-sm font-medium">Gemini usage</p>
          <p className="text-[11px] text-muted-foreground">
            Refreshes automatically
          </p>
        </div>

        {loading && !usage ? <UsageLoadingState /> : null}

        {error && !usage ? (
          <p className="rounded-md bg-destructive/8 px-2.5 py-2 text-xs leading-relaxed text-destructive">
            {error}
          </p>
        ) : null}

        {usage ? (
          <div className={cn(loading && "opacity-65")}>
            <UsageDetails usage={usage} />
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
