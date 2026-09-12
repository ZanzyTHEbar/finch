import { Context, Effect, Layer, Schema } from "effect"
import {
  StorageUnavailable,
  TenantId,
  ValidationFailed,
  type ProviderUnavailable,
  type BankSessionMissing,
  type TenantMismatch,
} from "@finch/core"
import { BANK_SYNC_JOB_KIND, JobRepository, type JobRow } from "@finch/db"
import { BankIngest } from "./ingest.ts"

export interface BankSyncDrainStats {
  readonly processed: number
  readonly succeeded: number
  readonly failed: number
}

export class BankSyncWorker extends Context.Tag("BankSyncWorker")<
  BankSyncWorker,
  {
    readonly drain: (limit?: number) => Effect.Effect<BankSyncDrainStats, StorageUnavailable | ValidationFailed>
    readonly requeueAllMissing: () => Effect.Effect<{ enqueued: number }, StorageUnavailable | ValidationFailed>
  }
>() {}

type BankSyncError =
  | ProviderUnavailable
  | BankSessionMissing
  | StorageUnavailable
  | ValidationFailed
  | TenantMismatch

export const BankSyncWorkerLive: Layer.Layer<
  BankSyncWorker,
  never,
  JobRepository | BankIngest
> = Layer.effect(
  BankSyncWorker,
  Effect.gen(function* () {
    const jobs = yield* JobRepository
    const ingest = yield* BankIngest

    const drain = (limit = 100): Effect.Effect<BankSyncDrainStats, StorageUnavailable | ValidationFailed> =>
      Effect.gen(function* () {
        yield* jobs.reclaimRunning(BANK_SYNC_JOB_KIND)
        let processed = 0
        let succeeded = 0
        let failed = 0
        for (;;) {
          const due = yield* jobs.listDueAll(BANK_SYNC_JOB_KIND, limit)
          if (due.length === 0) {
            break
          }
          let claimedThisPass = 0
          for (const job of due) {
            const tenantId = yield* Schema.decodeUnknown(TenantId)(job.tenantId).pipe(
              Effect.mapError(() => new ValidationFailed({ issues: [`job ${job.id} has invalid tenantId`] })),
            )
            const claimed = yield* jobs.claim(tenantId, job.id)
            if (!claimed) {
              continue
            }
            claimedThisPass += 1
            const outcome = yield* ingest.sync(tenantId).pipe(Effect.either)
            if (outcome._tag === "Left") {
              const lastError =
                outcome.left._tag === "ValidationFailed"
                  ? `${outcome.left._tag}: ${outcome.left.issues.join("; ")}`
                  : outcome.left._tag
              yield* jobs.finish(tenantId, job.id, { status: "failed", lastError })
              failed += 1
            } else {
              yield* jobs.finish(tenantId, job.id, { status: "succeeded" })
              succeeded += 1
            }
            processed += 1
          }
          if (claimedThisPass === 0) {
            break
          }
        }
        return { processed, succeeded, failed }
      })

    const requeueAllMissing = (): Effect.Effect<{ enqueued: number }, StorageUnavailable | ValidationFailed> =>
      Effect.gen(function* () {
        // Re-enqueue any jobs stuck in failed/running state for all tenants.
        // The job queue itself tracks tenants; for now, this is a no-op
        // until tenant-aware requeue logic is added.
        return { enqueued: 0 }
      })

    return { drain, requeueAllMissing }
  }),
)
