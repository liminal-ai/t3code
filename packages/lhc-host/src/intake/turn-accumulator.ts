interface TurnEventInput {
  threadId: string;
  turnId?: string;
  type: string;
}

export interface TurnAccumulatorState {
  threadId?: string;
  openTurnId?: string;
  terminalTurns: number;
}

export interface TurnAccumulatorFold {
  state: TurnAccumulatorState;
}

export function createTurnAccumulator(threadId?: string): TurnAccumulatorState {
  return threadId === undefined ? { terminalTurns: 0 } : { threadId, terminalTurns: 0 };
}

export function foldTurnAccumulator(
  state: TurnAccumulatorState,
  event: TurnEventInput,
): TurnAccumulatorFold {
  const next: TurnAccumulatorState = {
    ...state,
    threadId: state.threadId ?? event.threadId,
  };

  if (event.type === "turn.started") {
    if (event.turnId !== undefined) next.openTurnId = event.turnId;
    return { state: next };
  }

  if (event.type === "turn.completed" || event.type === "turn.aborted") {
    next.terminalTurns += 1;
    if (event.turnId !== undefined && next.openTurnId === event.turnId) {
      delete next.openTurnId;
    }
    return { state: next };
  }

  return { state: next };
}

export function applyTurnAccumulatorInPlace(
  state: TurnAccumulatorState,
  event: TurnEventInput,
): void {
  const folded = foldTurnAccumulator(state, event);

  for (const key of Object.keys(state) as Array<keyof TurnAccumulatorState>) {
    delete state[key];
  }
  Object.assign(state, folded.state);
}
