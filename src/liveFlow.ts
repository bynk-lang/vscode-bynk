// The request ordering behind a live panel (#32), kept free of `vscode` so the
// unit tests can drive it with controllable promises (see tsconfig.test.json).
// `livePanel.ts` supplies the editor side as `FlowDeps`.
//
// Every request bumps `seq`; whatever resumes from an `await` re-checks it
// before it touches `target` or renders, so an older answer can never overwrite
// a newer one. A refresh cut short by a newer request is remembered
// (`refreshLost`): if that request then has nothing to show, the refresh is
// re-issued, since the view would otherwise keep pre-edit content.

/** What a view shows: a document and, for a handler-scoped view, a position. */
export interface FlowTarget {
  uri: string;
  position?: { line: number; character: number };
  pinned?: boolean;
}

/** The follow state resolved for a target (the handler under it, its focus). */
export interface FlowScope {
  handler?: string;
  focus?: string;
}

export interface FlowDeps<P, T extends FlowTarget> {
  /** Issue the model request; `undefined` when there is no language client. */
  request(target: T, fresh: boolean, waitForClient: boolean): Promise<P | null | undefined>;
  /** Resolve the handler and focus a target sits in. */
  lookup(target: T): Promise<FlowScope>;
  /** Identity of the open panel, `undefined` when there is none. */
  panel(): unknown;
  visible(): boolean;
  /** Whether the page has been written (a restore with nothing yet shown). */
  pageLoaded(): boolean;
  ensurePanel(): void;
  render(payload: P | null): void;
  reveal(): void;
  /** A refresh is owed while the panel is hidden (`true`), or was just made. */
  setDirty(dirty: boolean): void;
  onError(err: unknown): void;
  onMiss(): void;
  /** Test seam counters. */
  onRefresh(): void;
  onNullRefresh(): void;
}

export type RetargetOutcome = "applied" | "superseded" | "empty";

export class LiveFlow<P, T extends FlowTarget> {
  target: T | undefined;
  handler: string | undefined;
  focus: string | undefined;
  private seq = 0;
  /** The seq of the refresh now in flight, 0 when none. */
  private refreshSeq = 0;
  private refreshLost = false;
  /** The seq of the show now in flight, 0 when none. */
  private showSeq = 0;
  /** An edit arrived after the show in flight made its request: its render
   *  is already stale, so the refresh follows it. */
  private editedDuringShow = false;

  constructor(private readonly deps: FlowDeps<P, T>) {}

  /** Explicit command: fetch fresh, then open (or reuse) the panel. */
  async show(next: T): Promise<void> {
    const seq = this.supersede();
    this.editedDuringShow = false;
    this.showSeq = seq;
    try {
      await this.showFrom(seq, next);
    } finally {
      if (this.showSeq === seq) this.showSeq = 0;
    }
  }

  private async showFrom(seq: number, next: T): Promise<void> {
    let payload: P | null | undefined;
    try {
      payload = await this.deps.request(next, true, false);
    } catch (err) {
      this.deps.onError(err);
      return this.settle(seq);
    }
    if (seq !== this.seq) return;
    if (payload === undefined) return this.settle(seq);
    if (!payload) {
      this.deps.onMiss();
      return this.settle(seq);
    }
    const scope = await this.deps.lookup(next);
    if (seq !== this.seq) return;
    this.refreshLost = false;
    this.apply(next, scope);
    this.deps.ensurePanel();
    this.deps.render(payload);
    this.deps.reveal();
    if (this.editedDuringShow) {
      this.editedDuringShow = false;
      this.showSeq = 0;
      void this.refresh();
    }
  }

  /** Re-pull for the current target and update the page in place. */
  async refresh(): Promise<void> {
    const panel = this.deps.panel();
    const target = this.target;
    if (!panel || !target) return;
    if (this.showSeq !== 0 && this.showSeq === this.seq) {
      // A command is fetching the view anew; it must not be cancelled. If it
      // ends without rendering, the refresh is redone.
      this.refreshLost = true;
      this.editedDuringShow = true;
      return;
    }
    if (!this.deps.visible()) {
      this.deps.setDirty(true);
      return;
    }
    this.deps.setDirty(false);
    const seq = ++this.seq;
    this.refreshSeq = seq;
    this.refreshLost = false;
    this.editedDuringShow = false;
    this.deps.onRefresh();
    let payload: P | null | undefined;
    try {
      payload = await this.deps.request(target, false, true);
    } catch {
      return this.refreshDone(seq); // keep showing the last good model
    }
    this.refreshDone(seq);
    if (payload === undefined) return;
    // A newer request (refresh, retarget or command) superseded this one, or
    // the panel closed meanwhile.
    if (seq !== this.seq || this.deps.panel() !== panel) return;
    // A target can lose its model for a moment — an edit swallowed the stored
    // position, or the file was saved mid-edit and does not parse. Keep the
    // last good model, as the throw path above does, rather than blanking the
    // view (a pinned one could not get back). Only a panel with nothing shown
    // yet (a restore) takes the empty state.
    if (payload === null) {
      this.deps.onNullRefresh();
      if (!this.deps.pageLoaded()) this.deps.render(null);
      return;
    }
    this.deps.render(payload);
  }

  /** A restored panel: take the persisted target, then re-request from it. */
  async restore(target: T): Promise<void> {
    const seq = this.supersede();
    this.target = target;
    this.handler = undefined;
    this.focus = undefined;
    const scope = await this.deps.lookup(target);
    if (seq !== this.seq) return; // a command or retarget took over meanwhile
    this.handler = scope.handler;
    this.focus = scope.focus;
    await this.refresh();
    // A restore with nothing to show (the file was deleted or renamed) still
    // needs a page: render the "nothing to show" state rather than an error.
    if (!this.deps.pageLoaded()) this.deps.render(null);
  }

  /** Follow-cursor: switch to `target` (whose scope is `scope`), if it has a
   *  model. */
  async retarget(target: T, scope: FlowScope): Promise<RetargetOutcome> {
    const seq = this.supersede();
    let payload: P | null | undefined;
    try {
      payload = await this.deps.request(target, false, false);
    } catch {
      this.settle(seq);
      return "empty";
    }
    if (seq !== this.seq) return "superseded";
    if (payload === undefined) {
      this.settle(seq);
      return "empty";
    }
    if (!this.deps.panel()) return "superseded";
    // A handler with no model (a wire contract for an agent handler, say)
    // keeps the last view rather than blanking it — but a refresh this
    // retarget cut short is still owed.
    if (!payload) {
      this.settle(seq);
      return "empty";
    }
    this.refreshLost = false;
    this.editedDuringShow = false;
    this.apply(target, scope);
    this.deps.render(payload);
    return "applied";
  }

  /** The panel closed: forget the target. */
  closed(): void {
    this.target = undefined;
    this.handler = undefined;
    this.refreshLost = false;
    this.editedDuringShow = false;
  }

  /** Start a request that makes any older one stale; a refresh in flight is
   *  owed again unless this request renders. */
  private supersede(): number {
    if (this.refreshSeq !== 0) this.refreshLost = true;
    return ++this.seq;
  }

  private refreshDone(seq: number): void {
    if (this.refreshSeq === seq) this.refreshSeq = 0;
  }

  private apply(target: T, scope: FlowScope): void {
    this.target = target;
    this.handler = scope.handler;
    this.focus = scope.focus;
  }

  /** A request ended without rendering: if nothing newer has started, redo
   *  the refresh it cut short. */
  private settle(seq: number): void {
    if (this.showSeq === seq) this.showSeq = 0;
    if (seq === this.seq) this.reissueLost();
  }

  private reissueLost(): void {
    if (!this.refreshLost) return;
    this.refreshLost = false;
    void this.refresh();
  }
}
