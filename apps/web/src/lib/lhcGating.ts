export const LHC_ACTION_PROVIDER_KINDS = new Set(["claudeAgent", "codex"]);

export type LhcActionGateInput = {
  readonly providerKind: string | null | undefined;
  readonly captured: boolean;
  readonly turnInFlight: boolean;
};

export type LhcActionGate = {
  readonly showActions: boolean;
  readonly actionsDisabled: boolean;
  readonly actionsDisabledReason: string | null;
};

export function isLhcActionProviderKind(providerKind: string | null | undefined): boolean {
  return (
    providerKind !== null &&
    providerKind !== undefined &&
    LHC_ACTION_PROVIDER_KINDS.has(providerKind)
  );
}

export function resolveLhcActionGate(input: LhcActionGateInput): LhcActionGate {
  if (!input.captured) {
    return {
      showActions: false,
      actionsDisabled: true,
      actionsDisabledReason: null,
    };
  }

  if (!isLhcActionProviderKind(input.providerKind)) {
    return {
      showActions: false,
      actionsDisabled: true,
      actionsDisabledReason: null,
    };
  }

  if (input.turnInFlight) {
    return {
      showActions: true,
      actionsDisabled: true,
      actionsDisabledReason: "Finish the current turn first",
    };
  }

  return {
    showActions: true,
    actionsDisabled: false,
    actionsDisabledReason: null,
  };
}
