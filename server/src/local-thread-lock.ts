/**
 * The run lock, without the platform.
 *
 * ONE RUN AT A TIME PER CONVERSATION. That's the whole contract, and upstream
 * gets it from CopilotKit's gateway because a hosted deployment may be several
 * servers and none of them can see the others' memory.
 *
 * This deployment is one process. A Map is the correct implementation, not a
 * compromise — a lock table in Postgres would be a network round trip to learn
 * something this process already knows.
 *
 * What it must preserve exactly:
 *
 *   acquire  returns { runId } when it took the lock, and **null** when someone
 *            else holds it. Null means contention and the caller retries; an
 *            exception means something is broken. Upstream is careful about
 *            that distinction and so is this, because returning null for a real
 *            failure makes every hop retry to exhaustion and tell the person
 *            their question was never answered.
 *
 *   renew    extends the hold. A run that takes ten minutes must not have its
 *            lock expire underneath it.
 *
 *   release  clears it. Called even when a run fails.
 *
 * The TTL matters for one case: a process that dies mid-run leaves a lock
 * behind, and without expiry that conversation is wedged until a restart. The
 * expiry is what makes a crash recoverable rather than permanent.
 */

type Held = {
  runId: string;
  userId: string;
  agentId: string;
  expiresAt: number;
};

export class LocalThreadLock {
  #held = new Map<string, Held>();

  constructor(private readonly ttlMs: number) {}

  /** A lock past its expiry is not held. Read lazily rather than swept. */
  #live(threadId: string): Held | null {
    const h = this.#held.get(threadId);
    if (!h) return null;
    if (h.expiresAt <= Date.now()) {
      this.#held.delete(threadId);
      return null;
    }
    return h;
  }

  async acquire(input: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
  }): Promise<{ runId: string } | null> {
    const existing = this.#live(input.threadId);

    if (existing) {
      // Re-acquiring your own lock is a renewal, not a conflict. A retry that
      // arrives after the first attempt already took the lock must not deadlock
      // against itself.
      if (existing.runId === input.runId) {
        existing.expiresAt = Date.now() + this.ttlMs;
        return { runId: existing.runId };
      }
      return null; // somebody else is running this conversation
    }

    this.#held.set(input.threadId, {
      runId: input.runId,
      userId: input.userId,
      agentId: input.agentId,
      expiresAt: Date.now() + this.ttlMs,
    });
    return { runId: input.runId };
  }

  async renew(input: { threadId: string; runId: string }): Promise<void> {
    const h = this.#live(input.threadId);
    // Renewing a lock you no longer hold is silently ignored, matching a
    // gateway that would reject it. Throwing here would kill a run for losing
    // a race it has already recovered from.
    if (h && h.runId === input.runId) {
      h.expiresAt = Date.now() + this.ttlMs;
    }
  }

  async release(input: { threadId: string; runId: string }): Promise<void> {
    const h = this.#held.get(input.threadId);
    // Only the holder may release, or a late release from a finished run would
    // unlock the conversation underneath whoever took it next.
    if (h && h.runId === input.runId) {
      this.#held.delete(input.threadId);
    }
  }

  /** For a status screen: which conversations are mid-run. */
  busy(): string[] {
    const out: string[] = [];
    for (const threadId of this.#held.keys()) {
      if (this.#live(threadId)) out.push(threadId);
    }
    return out;
  }
}
