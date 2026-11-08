// Store の結果型を HTTP 向け error に変換し、queue の業務操作を公開する
import { randomBytes } from "node:crypto";
import type { QueueState } from "../../shared/queue.ts";
import { WaitingRoomError } from "./errors.ts";
import {
  type QueueResult,
  PostgresWaitingRoomStore,
  SESSION_LIFETIME_SECONDS,
} from "./store.ts";

/** 待機列の操作と保護判定を store に委譲し、拒否理由を domain error にする */
export class WaitingRoomService {
  readonly #store: PostgresWaitingRoomStore;

  constructor(store: PostgresWaitingRoomStore) {
    this.#store = store;
  }

  /** 有効な入場券を再利用し、なければ匿名 session を発行して参加する */
  async enter(
    sessionId: string | null,
    signal: AbortSignal,
  ): Promise<{
    state: QueueState;
    sessionToken: string | null;
    sessionExpiresIn: number;
  }> {
    if (sessionId) {
      try {
        return {
          state: await this.join(sessionId, signal),
          sessionToken: null,
          sessionExpiresIn: SESSION_LIFETIME_SECONDS,
        };
      } catch (error) {
        if (
          !(error instanceof WaitingRoomError) ||
          error.code !== "AUTH_REQUIRED"
        ) {
          throw error;
        }
      }
    }
    const sessionToken = randomBytes(32).toString("base64url");
    await this.#store.createAnonymousSession(sessionToken, signal);
    return {
      state: await this.join(sessionToken, signal),
      sessionToken,
      sessionExpiresIn: SESSION_LIFETIME_SECONDS,
    };
  }

  async join(sessionId: string, signal: AbortSignal): Promise<QueueState> {
    return this.#unwrap(await this.#store.join(sessionId, signal));
  }

  async poll(sessionId: string, signal: AbortSignal): Promise<QueueState> {
    return this.#unwrap(await this.#store.poll(sessionId, signal));
  }

  async renew(sessionId: string, signal: AbortSignal): Promise<QueueState> {
    return this.#unwrap(await this.#store.renew(sessionId, signal));
  }

  async leave(sessionId: string, signal: AbortSignal): Promise<void> {
    this.#unwrap(await this.#store.leave(sessionId, signal));
  }

  async authorize(sessionId: string, signal: AbortSignal): Promise<boolean> {
    return this.#unwrap(await this.#store.authorize(sessionId, signal));
  }

  /** Store の失敗 discriminant を HTTP status 付き error に変換する */
  #unwrap<T>(result: QueueResult<T>): T {
    if ("value" in result) {
      return result.value;
    }

    switch (result.error) {
      case "AUTH_REQUIRED":
        throw new WaitingRoomError(401, result.error);
      case "QUEUE_NOT_JOINED":
      case "NOT_ADMITTED":
        throw new WaitingRoomError(409, result.error);
    }
  }
}
