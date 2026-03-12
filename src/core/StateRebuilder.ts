import type { StoredEvent } from './EventStore.js';

type EventReducer<State> = (state: State, event: StoredEvent) => State;

export class StateRebuilder<State> {
  constructor(
    private initialState: State,
    private reducer: EventReducer<State>
  ) {}

  rebuild(events: StoredEvent[]): State {
    const base =
      typeof structuredClone === 'function'
        ? structuredClone(this.initialState)
        : JSON.parse(JSON.stringify(this.initialState));

    return events.reduce((state, event) => this.reducer(state, event), base);
  }
}
