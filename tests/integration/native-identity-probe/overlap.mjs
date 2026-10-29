// An out-of-band diagnostic barrier proves two authenticated tool requests were simultaneously pending.
export function createOverlapController() {
  let active;
  let nextId = 0;
  const evidence = [];

  function arm({ providers, timeoutMs, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout }) {
    if (active || !Array.isArray(providers) || providers.length !== 2 || providers.some((provider) => !["claude", "codex"].includes(provider)) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid overlap barrier");
    let firstArrival;
    let result;
    const pending = {
      id: `b${++nextId}`, providers: [...providers], participants: [],
      arrival: new Promise((resolve) => { firstArrival = resolve; }),
      result: new Promise((resolve) => { result = resolve; }),
      firstArrival, resolve: result, cancelTimeout,
    };
    active = pending;
    pending.timer = scheduleTimeout(() => finish(pending, false), timeoutMs);
    return { firstArrival: pending.arrival, result: pending.result, cancel: () => finish(pending, false) };
  }

  function finish(pending, verified) {
    if (active !== pending) return;
    const complete = verified && pending.participants.length === 2 && pending.participants.every(({ response }) => !response.destroyed && !response.writableEnded);
    pending.cancelTimeout(pending.timer);
    active = undefined;
    const receipt = { barrier: pending.id, providers: pending.participants.map(({ record }) => record.kind), overlapVerified: complete };
    evidence.push(receipt);
    for (const participant of pending.participants) {
      participant.response.off("close", participant.disconnected);
      if (complete) Object.assign(participant.record, { barrier: pending.id, overlapVerified: true });
      participant.resolve(complete ? undefined : "overlap not established");
    }
    pending.firstArrival();
    pending.resolve({ ...receipt, providers: [...receipt.providers] });
  }

  function enter(record, response) {
    const pending = active;
    if (!pending) return Promise.resolve(undefined);
    const consumed = pending.participants.filter((participant) => participant.record.kind === record.kind).length;
    const available = pending.providers.filter((provider) => provider === record.kind).length;
    if (consumed >= available || pending.participants.some((participant) => participant.record.identity === record.identity || participant.response === response)) return Promise.resolve("overlap participant rejected");
    return new Promise((resolve) => {
      const participant = { record, response, resolve, disconnected: () => finish(pending, false) };
      pending.participants.push(participant);
      response.once("close", participant.disconnected);
      if (response.destroyed || response.writableEnded) finish(pending, false);
      else if (pending.participants.length === 2) finish(pending, true);
      else pending.firstArrival();
    });
  }

  return {
    arm, enter,
    close: () => { if (active) finish(active, false); },
    report: () => evidence.map((receipt) => ({ ...receipt, providers: [...receipt.providers] })),
  };
}
