/** 待合と保護画面の間で共有する API の状態・エラー契約 */
export type QueueStatus = "waiting" | "admitted";

/** `ahead` は待機中の前方人数で、入場済みの場合は `null` */
export interface QueueState {
  status: QueueStatus;
  // 入場済みになると待機順から外れるため、前方人数は null
  ahead: number | null;
}

/** HTTP エラー応答から画面へ渡す安定した識別子 */
export interface ApiError {
  code: string;
}

/** 待合 API が返す代表的な状態エラー */
export type QueueErrorCode =
  | "AUTH_REQUIRED"
  | "QUEUE_NOT_JOINED"
  | "NOT_ADMITTED"
  | "UNAVAILABLE";
