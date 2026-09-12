import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import {
  DownloadUrlSchema,
  GetReceiptDownloadUrlResponseSchema,
  GetReceiptResponseSchema,
  ListReceiptsResponseSchema,
  MoneySchema,
  PageResponseSchema,
  ReceiptSchema,
  ReceiptService,
  ReceiptStatus,
  UploadHttpMethod,
  UploadTargetSchema,
  CreateReceiptUploadIntentResponseSchema,
  FinalizeReceiptResponseSchema,
} from "@finch/contracts"
import {
  ReceiptConflict,
  ReceiptHashMismatch,
  ReceiptMetadataMismatch,
  ReceiptNotFound,
  ReceiptPort,
  ReceiptUnavailable,
  ReceiptWriteDenied,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  createReceiptUploadIntent,
  finalizeReceipt,
  getReceipt,
  getReceiptDownloadUrl,
  listReceipts,
  type Receipt,
  type ReceiptMoney,
} from "@finch/lib"
import { requireConnectPrincipal, type ConnectPrincipalResolver } from "./principal.ts"

const toMoney = (money: ReceiptMoney) =>
  create(MoneySchema, { minorUnits: money.minorUnits, currency: money.currency })

const toReceiptStatus = (status: Receipt["status"]) => {
  switch (status) {
    case "pending":
      return ReceiptStatus.UPLOAD_PENDING
    case "ready":
      return ReceiptStatus.READY
    case "failed":
      return ReceiptStatus.FAILED
  }
}

const toReceipt = (receipt: Receipt) =>
  create(ReceiptSchema, {
    id: receipt.id,
    status: toReceiptStatus(receipt.status),
    contentType: receipt.contentType,
    createdAt: receipt.createdAt,
    ...(receipt.fileName === undefined ? {} : { fileName: receipt.fileName }),
    ...(receipt.merchant === undefined ? {} : { merchant: receipt.merchant }),
    ...(receipt.total === undefined ? {} : { total: toMoney(receipt.total) }),
    ...(receipt.receiptDate === undefined ? {} : { receiptDate: receipt.receiptDate }),
  })

const toPage = (nextPageToken: string | undefined) =>
  create(PageResponseSchema, { nextPageToken: nextPageToken ?? "" })

const toPageInput = (page: { readonly pageSize: number; readonly pageToken: string } | undefined) =>
  page === undefined ? undefined : { pageSize: page.pageSize, pageToken: page.pageToken }

export const toReceiptConnectError = (cause: unknown): ConnectError => {
  if (cause instanceof ConnectError) return cause
  if (cause instanceof WorkspaceAccessDenied || cause instanceof ReceiptWriteDenied) {
    return new ConnectError("workspace access denied", Code.PermissionDenied)
  }
  if (cause instanceof WorkspaceAccessUnavailable) {
    return new ConnectError("workspace access unavailable", Code.Unavailable)
  }
  if (cause instanceof ValidationFailed) {
    return new ConnectError(`invalid receipt request: ${cause.issues.join("; ")}`, Code.InvalidArgument)
  }
  if (cause instanceof ReceiptNotFound) {
    return new ConnectError("receipt not found", Code.NotFound)
  }
  if (cause instanceof ReceiptConflict) {
    return new ConnectError("receipt state conflict", Code.Aborted)
  }
  if (cause instanceof ReceiptHashMismatch) {
    return new ConnectError("receipt content hash mismatch", Code.FailedPrecondition)
  }
  if (cause instanceof ReceiptMetadataMismatch) {
    return new ConnectError("receipt content metadata mismatch", Code.FailedPrecondition)
  }
  if (cause instanceof ReceiptUnavailable) {
    return new ConnectError("receipt unavailable", Code.Unavailable)
  }
  return new ConnectError("receipt failed", Code.Internal)
}

export interface ReceiptServiceDependencies<E> {
  readonly principalResolver: ConnectPrincipalResolver
  readonly layer: Layer.Layer<ReceiptPort | WorkspaceAccess, E>
}

export interface ReceiptServiceHandle {
  readonly impl: ServiceImpl<typeof ReceiptService>
  readonly dispose: () => Promise<void>
}

type ReceiptUseCaseError =
  | ReceiptConflict
  | ReceiptHashMismatch
  | ReceiptMetadataMismatch
  | ReceiptNotFound
  | ReceiptUnavailable
  | ReceiptWriteDenied
  | ValidationFailed
  | WorkspaceAccessDenied
  | WorkspaceAccessUnavailable

export const makeReceiptService = <E>(
  dependencies: ReceiptServiceDependencies<E>,
  runtime: ManagedRuntime.ManagedRuntime<ReceiptPort | WorkspaceAccess, E> = ManagedRuntime.make(dependencies.layer),
): ReceiptServiceHandle => {
  const run = <A>(effect: Effect.Effect<A, ReceiptUseCaseError, ReceiptPort | WorkspaceAccess>) =>
    runtime.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value
      throw toReceiptConnectError(Cause.squash(exit.cause))
    })

  return {
    impl: {
      listReceipts: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const result = await run(listReceipts(principal, {
          workspaceId: request.workspaceId,
          page: toPageInput(request.page),
        }))
        return create(ListReceiptsResponseSchema, {
          receipts: result.receipts.map(toReceipt),
          page: toPage(result.nextPageToken),
        })
      },
      getReceipt: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const receipt = await run(getReceipt(principal, {
          workspaceId: request.workspaceId,
          receiptId: request.receiptId,
        }))
        return create(GetReceiptResponseSchema, { receipt: toReceipt(receipt) })
      },
      createReceiptUploadIntent: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const result = await run(createReceiptUploadIntent(principal, {
          workspaceId: request.workspaceId,
          fileName: request.fileName,
          contentType: request.contentType,
          contentLength: request.contentLength,
          sha256: request.sha256,
          idempotencyKey: request.idempotencyKey,
          ...(request.merchant === undefined ? {} : { merchant: request.merchant }),
          ...(request.total === undefined ? {} : { total: request.total }),
          ...(request.receiptDate === undefined ? {} : { receiptDate: request.receiptDate }),
        }))
        return create(CreateReceiptUploadIntentResponseSchema, {
          receipt: toReceipt(result.receipt),
          upload: create(UploadTargetSchema, {
            url: result.upload.url,
            method: UploadHttpMethod.PUT,
            requiredHeaders: result.upload.requiredHeaders.map((header) => ({ name: header.name, value: header.value })),
          }),
        })
      },
      finalizeReceipt: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const receipt = await run(finalizeReceipt(principal, {
          workspaceId: request.workspaceId,
          receiptId: request.receiptId,
        }))
        return create(FinalizeReceiptResponseSchema, { receipt: toReceipt(receipt) })
      },
      getReceiptDownloadUrl: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const download = await run(getReceiptDownloadUrl(principal, {
          workspaceId: request.workspaceId,
          receiptId: request.receiptId,
        }))
        return create(GetReceiptDownloadUrlResponseSchema, {
          download: create(DownloadUrlSchema, { url: download.url, expiresAt: download.expiresAt }),
        })
      },
    },
    dispose: () => runtime.dispose(),
  }
}
