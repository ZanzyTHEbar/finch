declare const Deno: {
  readonly env: { readonly get: (name: string) => string | undefined }
  readonly serve: (handler: (request: Request) => Response | Promise<Response>) => void
}

declare module "npm:jose@6.2.12" {
  export * from "jose"
}

declare module "npm:@supabase/supabase-js@2.116.0" {
  export * from "@supabase/supabase-js"
}
