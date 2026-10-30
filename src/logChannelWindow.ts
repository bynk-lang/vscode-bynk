// How often the Bynk Logs output channel is rebuilt (#37). The channel is
// append-only, so it grows past the buffer between rebuilds; letting it reach
// twice the buffer before rendering it afresh amortizes the cost — a rebuild
// every `limit` lines once the buffer is full, not one per line. No `vscode`
// import, so the unit tests compile against it directly.

export class ChannelWindow {
  /** Lines in the channel since it was last rendered whole. */
  private count = 0;

  constructor(private readonly limit: number) {}

  /** A line is about to be appended: whether to rebuild the channel instead. */
  append(): boolean {
    return ++this.count > this.limit * 2;
  }

  /** The channel was rendered whole with `lines` lines. */
  rendered(lines: number): void {
    this.count = lines;
  }
}
