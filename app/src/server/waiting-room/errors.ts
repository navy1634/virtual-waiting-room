// 待合 domain の拒否と DB 障害を、HTTP 層が区別できる error
export class WaitingRoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "WaitingRoomError";
  }
}

/** PostgreSQL を安全に利用できないとき、入場を拒否する error */
export class StoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("The waiting room store is unavailable", { cause });
    this.name = "StoreUnavailableError";
  }
}
