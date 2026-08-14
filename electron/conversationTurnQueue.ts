export class ConversationTurnQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(conversationId, tail);
    return result.finally(() => {
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    });
  }

  pendingConversationCount(): number {
    return this.tails.size;
  }
}
