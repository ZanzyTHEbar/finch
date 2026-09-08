import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { exportPKCS8, generateKeyPair, importSPKI, jwtVerify } from "jose"
import { signEnableBankingJwt } from "../../packages/enablebanking/src/jwt.ts"

describe("signEnableBankingJwt", () => {
  it("signs an RS256 JWT with kid, iss, and aud", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
    const pem = await exportPKCS8(privateKey)
    const applicationId = "app-finch-test"
    const token = await signEnableBankingJwt(applicationId, pem)
    const { payload, protectedHeader } = await jwtVerify(token, publicKey)
    expect(protectedHeader.alg).toBe("RS256")
    expect(protectedHeader.kid).toBe(applicationId)
    expect(payload.iss).toBe("enablebanking.com")
    expect(payload.aud).toBe("api.enablebanking.com")
  })

  it("signs PKCS#1 PEM from openssl genrsa", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const pkcs1 = pair.privateKey.export({ type: "pkcs1", format: "pem" })
    const spki = pair.publicKey.export({ type: "spki", format: "pem" })
    const pem = typeof pkcs1 === "string" ? pkcs1 : pkcs1.toString()
    const spkiPem = typeof spki === "string" ? spki : spki.toString()
    const token = await signEnableBankingJwt("app-pkcs1", pem)
    const key = await importSPKI(spkiPem, "RS256")
    const { protectedHeader } = await jwtVerify(token, key)
    expect(protectedHeader.alg).toBe("RS256")
    expect(protectedHeader.kid).toBe("app-pkcs1")
  })
})
