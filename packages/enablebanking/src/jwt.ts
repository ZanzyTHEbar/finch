import { createPrivateKey } from "node:crypto"
import { SignJWT } from "jose"

export const signEnableBankingJwt = async (
  applicationId: string,
  privateKeyPem: string,
): Promise<string> => {
  // openssl genrsa emits PKCS#1; jose importPKCS8 is PKCS#8-only.
  const key = createPrivateKey(privateKeyPem)
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "RS256", kid: applicationId })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)
}
