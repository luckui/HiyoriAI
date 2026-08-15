export class SerialPlaybackQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get pendingCount(): number {
    return this.pending;
  }

  enqueue<T>(playback: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(async () => {
      try {
        return await playback();
      } finally {
        this.pending -= 1;
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
