/**
 * Threads and history, without the platform.
 *
 * STAGE ONE, AND SAYING SO ON PURPOSE.
 *
 * Upstream reads three things from CopilotKit: whether a thread exists, a
 * thread created on demand, and a thread's messages. All three come back from
 * their service, which also wrote them — the runtime hands it every turn.
 *
 * Hand the runtime no intelligence client and it stops sending turns anywhere,
 * so nothing is writing history. The open question is whether the runtime keeps
 * its own copy in that mode or keeps none at all, and no amount of reading
 * their source settles it: the behaviour lives in a compiled package.
 *
 * So this answers honestly rather than pretending. A thread always exists, and
 * its history is empty. That makes the deployment BOOT AND RUN, which is what
 * turns the question into an observable one — start it, have a conversation,
 * reload, and see whether anything came back.
 *
 *   If history survives, the runtime is persisting it and these reads should
 *   point at wherever it put it.
 *
 *   If it doesn't, this file grows two Postgres tables and starts recording
 *   turns itself. The database is already there.
 *
 * Either way the answer costs one conversation instead of a day of building
 * against a guess. An empty transcript that runs beats a full one built on an
 * assumption about a package nobody has watched work.
 */

export type LocalThread = {
  threadId: string;
  userId: string;
  createdAt: string;
};

export class LocalTranscript {
  #threads = new Map<string, LocalThread>();

  /**
   * Does this thread exist.
   *
   * Upstream's subclass already makes an unrun thread read as empty rather than
   * a 500 — see IntelligenceKnowingANewThread — so "yes, and it's empty" is the
   * shape the callers were written against.
   */
  async getThread(input: { threadId: string; userId: string }): Promise<LocalThread> {
    return this.getOrCreateThread(input);
  }

  async getOrCreateThread(input: {
    threadId: string;
    userId: string;
  }): Promise<LocalThread> {
    const existing = this.#threads.get(input.threadId);
    if (existing) return existing;

    const created: LocalThread = {
      threadId: input.threadId,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    };
    this.#threads.set(input.threadId, created);
    return created;
  }

  /**
   * The conversation so far.
   *
   * Empty, deliberately, until the question above is answered. Returning made-up
   * history would be worse than returning none: a Bot answering from a
   * transcript that never happened is a failure nobody can see.
   */
  async getThreadMessages(_input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: unknown[] }> {
    return { messages: [] };
  }
}
