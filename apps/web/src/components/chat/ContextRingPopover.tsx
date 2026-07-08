import type { ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  fetchLhcThreadInspect,
  formatLhcActionError,
  formatLhcSuccessToast,
  isLhcRouteLevelFailure,
  isLhcRoutesUnavailable,
  LhcApiError,
  postLhcCompact,
  postLhcPrune,
  type LhcThreadInspectResponse,
} from "~/lib/lhcApi";
import { resolveLhcActionGate } from "~/lib/lhcGating";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextWindowMeter } from "./ContextWindowMeter";

type LhcInspectState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly inspect: LhcThreadInspectResponse }
  | { readonly kind: "not_captured" }
  | { readonly kind: "error"; readonly message: string };

export const ContextRingPopover = memo(function ContextRingPopover(props: {
  threadId: ThreadId | null;
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null;
  turnInFlight: boolean;
}) {
  const { threadId, usage, providerDisplayName, turnInFlight } = props;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [lhcInactive, setLhcInactive] = useState(() => isLhcRoutesUnavailable());
  const [open, setOpen] = useState(false);
  const [inspectState, setInspectState] = useState<LhcInspectState>({ kind: "idle" });
  const [compactRecommended, setCompactRecommended] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<"compact" | "prune" | null>(null);
  const previousTurnInFlightRef = useRef(turnInFlight);

  const deactivateLhc = useCallback(() => {
    setLhcInactive(true);
    setOpen(false);
    setInspectState({ kind: "idle" });
    setCompactRecommended(false);
    setActionInFlight(null);
  }, []);

  const loadInspect = useCallback(async () => {
    if (lhcInactive || isLhcRoutesUnavailable()) {
      deactivateLhc();
      return;
    }
    if (!threadId) {
      setInspectState({ kind: "idle" });
      setCompactRecommended(false);
      return;
    }

    setInspectState({ kind: "loading" });
    try {
      const inspect = await fetchLhcThreadInspect(threadId);
      setInspectState({ kind: "ready", inspect });
      setCompactRecommended(inspect.compactRecommended);
    } catch (error) {
      if (isLhcRoutesUnavailable() || isLhcRouteLevelFailure(error)) {
        deactivateLhc();
        return;
      }
      if (error instanceof LhcApiError && error.code === "not_captured") {
        setInspectState({ kind: "not_captured" });
        setCompactRecommended(false);
        return;
      }
      if (error instanceof LhcApiError && error.code === "lhc_unavailable") {
        deactivateLhc();
        return;
      }
      setInspectState({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to load LHC context.",
      });
    }
  }, [deactivateLhc, lhcInactive, threadId]);

  useEffect(() => {
    if (open && !lhcInactive) {
      void loadInspect();
    }
  }, [lhcInactive, loadInspect, open]);

  useEffect(() => {
    setInspectState({ kind: "idle" });
    setCompactRecommended(false);
  }, [threadId]);

  useEffect(() => {
    const wasRunning = previousTurnInFlightRef.current;
    previousTurnInFlightRef.current = turnInFlight;
    if (!lhcInactive && wasRunning && !turnInFlight && threadId) {
      void loadInspect();
    }
  }, [lhcInactive, loadInspect, threadId, turnInFlight]);

  const inspect = inspectState.kind === "ready" ? inspectState.inspect : null;
  const captured = inspectState.kind === "ready";
  const actionGate = resolveLhcActionGate({
    providerKind: inspect?.providerKind,
    captured,
    turnInFlight,
  });

  const runAction = useCallback(
    async (op: "compact" | "prune") => {
      if (lhcInactive || !threadId || actionGate.actionsDisabled || actionInFlight !== null) {
        return;
      }

      setActionInFlight(op);
      try {
        const receipt =
          op === "compact" ? await postLhcCompact(threadId) : await postLhcPrune(threadId);
        const toast = formatLhcSuccessToast(op, receipt);
        toastManager.add({
          type: "success",
          title: toast.title,
          ...(toast.description ? { description: toast.description } : {}),
        });
        await loadInspect();
      } catch (error) {
        if (isLhcRoutesUnavailable() || isLhcRouteLevelFailure(error)) {
          deactivateLhc();
          return;
        }
        toastManager.add({
          type: "error",
          title: op === "compact" ? "Compact failed" : "Prune failed",
          description:
            error instanceof LhcApiError
              ? formatLhcActionError(error)
              : error instanceof Error
                ? error.message
                : "An error occurred.",
        });
      } finally {
        setActionInFlight(null);
      }
    },
    [actionGate.actionsDisabled, actionInFlight, deactivateLhc, lhcInactive, loadInspect, threadId],
  );

  const usedPercentage =
    usage.usedPercentage !== null && Number.isFinite(usage.usedPercentage)
      ? usage.usedPercentage < 10
        ? `${usage.usedPercentage.toFixed(1).replace(/\.0$/, "")}%`
        : `${Math.round(usage.usedPercentage)}%`
      : null;

  if (lhcInactive) {
    return (
      <ContextWindowMeter
        usage={usage}
        {...(providerDisplayName !== undefined ? { providerDisplayName } : {})}
      />
    );
  }

  return (
    <>
      <div
        ref={anchorRef}
        className="relative inline-flex"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {compactRecommended ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-0 z-10 size-1.5 rounded-full bg-amber-500 ring-1 ring-background"
          />
        ) : null}
        <ContextWindowMeter
          usage={usage}
          {...(providerDisplayName !== undefined ? { providerDisplayName } : {})}
        />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverPopup anchor={anchorRef} side="top" align="end" className="w-72 max-w-none p-0">
          <div className="flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-muted-foreground text-xs">LHC context</div>
              {usage.maxTokens !== null && usedPercentage ? (
                <div className="text-[11px] tabular-nums text-muted-foreground/70">
                  <span>{usedPercentage}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </div>
              ) : (
                <div className="text-[11px] tabular-nums text-muted-foreground/70">
                  Provider {formatContextWindowTokens(usage.usedTokens)}
                </div>
              )}
            </div>

            {inspectState.kind === "loading" ? (
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Spinner className="size-3.5" />
                <span>Loading LHC status…</span>
              </div>
            ) : null}

            {inspectState.kind === "not_captured" ? (
              <div className="text-[11px] text-muted-foreground/80">Not captured by LHC</div>
            ) : null}

            {inspectState.kind === "error" ? (
              <div className="text-[11px] text-destructive">{inspectState.message}</div>
            ) : null}

            {inspect ? (
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">LHC record</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium tabular-nums text-muted-foreground/80">
                    {formatContextWindowTokens(inspect.tailTokens)}
                  </span>
                  {inspect.compactRecommended ? (
                    <Badge variant="warning" size="sm">
                      Compact recommended
                    </Badge>
                  ) : null}
                </div>
              </div>
            ) : null}

            {actionGate.showActions ? (
              <div className="flex flex-col gap-2 border-t pt-3">
                {(["compact", "prune"] as const).map((op) => {
                  const label = op === "compact" ? "Smart compact" : "Prune tool outputs";
                  const disabled = actionGate.actionsDisabled || actionInFlight !== null;
                  const button = (
                    <Button
                      key={op}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full justify-center"
                      disabled={disabled}
                      onClick={() => {
                        void runAction(op);
                      }}
                    >
                      {actionInFlight === op ? <Spinner className="size-3.5" /> : null}
                      {label}
                    </Button>
                  );

                  if (actionGate.actionsDisabled && actionGate.actionsDisabledReason) {
                    return (
                      <Tooltip key={op}>
                        <TooltipTrigger render={button} />
                        <TooltipPopup side="top">{actionGate.actionsDisabledReason}</TooltipPopup>
                      </Tooltip>
                    );
                  }

                  return button;
                })}
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
});
